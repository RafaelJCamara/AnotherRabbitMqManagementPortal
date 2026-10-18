// Role `observe` (taps): the tap queues of this connection, and nothing else. A tap queue is
// exclusive, auto-delete, non-durable and bounded (`x-max-length` with `drop-head`, a TTL and an
// `x-expires`), so it vanishes with the connection and can never fill a broker. The lease binds,
// consumes and acknowledges only queues it declared itself, so it cannot read or settle a user's
// message: `ackTap` acknowledges copies, and the user's original was routed to its own queue by the
// broker, never delivered here.
import type { ObserveLease, TapQueueSpec } from '@app/ports';

import type { Amqp091Connection } from '../connect.ts';
import { TrackedChannel, withTimeout } from '../channel.ts';
import { Amqp091Error, safeText } from '../errors.ts';
import { TagLedger, toWireTag } from '../proofs.ts';
import {
  requireKey,
  requireName,
  requirePrefetch,
  startConsumer,
} from './shared.ts';

const MAX_TAP_QUEUES = 32;
const TAP_NAME = /^[^\s/]+\.tap\.[^\s/]+$/;
const NUMERIC_ARGS = ['x-max-length', 'x-message-ttl', 'x-expires'] as const;
const SESSION_ARG = /^x-[a-z0-9-]+-session$/;

function invalid(detail: string): Amqp091Error {
  return new Amqp091Error('invalid-argument', detail);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The runtime half of `TapQueueSpec`: the same shape the type demands, checked on real values. */
function checkTapSpec(spec: TapQueueSpec): Record<string, unknown> {
  const candidate = asRecord(spec);
  if (
    candidate === undefined ||
    typeof candidate.name !== 'string' ||
    !TAP_NAME.test(candidate.name) ||
    candidate.name.length > 255
  ) {
    throw invalid('a tap queue is named <prefix>.tap.<id>');
  }
  if (
    candidate.exclusive !== true ||
    candidate.autoDelete !== true ||
    candidate.durable !== false
  ) {
    throw invalid('a tap queue is exclusive, auto-delete and not durable');
  }
  const args = asRecord(candidate.args);
  if (args === undefined) {
    throw invalid('a tap queue needs its bounded arguments');
  }
  if (
    args['x-queue-type'] !== 'classic' ||
    args['x-overflow'] !== 'drop-head'
  ) {
    throw invalid('a tap queue is classic with x-overflow drop-head');
  }
  const out: Record<string, unknown> = {
    'x-queue-type': 'classic',
    'x-overflow': 'drop-head',
  };
  for (const key of NUMERIC_ARGS) {
    const value = args[key];
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 1
    ) {
      throw invalid(`${key} is required and must be a positive integer`);
    }
    out[key] = value;
  }
  for (const key of Object.keys(args)) {
    if (key in out) continue;
    const value = args[key];
    if (
      !SESSION_ARG.test(key) ||
      typeof value !== 'string' ||
      value.length > 255
    ) {
      throw invalid(
        `the tap queue argument ${safeText(key, 40)} is not allowed`,
      );
    }
    out[key] = value;
  }
  return out;
}

function checkBindingArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw invalid('binding arguments must be an object');
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(args)) {
    const value = (args as Record<string, unknown>)[key];
    if (
      typeof value !== 'string' &&
      typeof value !== 'boolean' &&
      !(typeof value === 'number' && Number.isFinite(value))
    ) {
      throw invalid('binding argument values are strings, booleans or numbers');
    }
    out[key] = value;
  }
  return out;
}

export function createObserveLease(
  connection: Amqp091Connection,
): ObserveLease {
  const own = new Set<string>();
  let control: TrackedChannel | undefined;
  let consumer: TrackedChannel | undefined;
  let held: TagLedger | undefined;
  let consumerTag: string | undefined;
  let released: Promise<void> | undefined;

  function live(): void {
    if (released !== undefined) {
      throw new Amqp091Error('released', 'the lease was released');
    }
    connection.assertOpen();
  }

  function ownQueue(queue: string): string {
    requireName(queue, 'the queue name');
    if (!own.has(queue)) {
      throw new Amqp091Error(
        'not-own-queue',
        'an observe lease works only on the tap queues it declared',
      );
    }
    return queue;
  }

  async function controlChannel(): Promise<TrackedChannel> {
    if (control === undefined || control.lost !== undefined) {
      control = await connection.openChannel();
    }
    return control;
  }

  async function call<T>(what: string, run: (c: TrackedChannel) => Promise<T>) {
    const channel = await controlChannel();
    try {
      return await withTimeout(
        run(channel),
        connection.operationTimeoutMs,
        what,
      );
    } catch (error) {
      throw channel.explain(error, what);
    }
  }

  const lease: ObserveLease = {
    async declareTapQueue(spec: TapQueueSpec): Promise<void> {
      live();
      const args = checkTapSpec(spec);
      if (!own.has(spec.name) && own.size >= MAX_TAP_QUEUES) {
        throw invalid(`at most ${String(MAX_TAP_QUEUES)} tap queues per lease`);
      }
      await call('declaring a tap queue', (c) =>
        c.raw.assertQueue(spec.name, {
          exclusive: true,
          durable: false,
          autoDelete: true,
          arguments: args,
        }),
      );
      own.add(spec.name);
    },

    async bindQueue(queue, source, key, args): Promise<void> {
      live();
      ownQueue(queue);
      const exchange = requireName(source, 'the exchange name');
      const table = checkBindingArgs(args);
      await call('binding a tap queue', (c) =>
        c.raw.bindQueue(queue, exchange, requireKey(key), table),
      );
    },

    async unbindQueue(queue, source, key, args): Promise<void> {
      live();
      ownQueue(queue);
      const exchange = requireName(source, 'the exchange name');
      const table = checkBindingArgs(args);
      await call('unbinding a tap queue', (c) =>
        c.raw.unbindQueue(queue, exchange, requireKey(key), table),
      );
    },

    async consume(queue, prefetch, onDelivery) {
      live();
      ownQueue(queue);
      requirePrefetch(prefetch, 1);
      if (typeof onDelivery !== 'function') {
        throw invalid('onDelivery must be a function');
      }
      if (consumer !== undefined) {
        throw new Amqp091Error('busy', 'an observe lease has one consumer');
      }
      // Its own channel: a tap's flow control must not delay the declares on the other one.
      const channel = await connection.openChannel();
      consumer = channel;
      const ledger = new TagLedger(prefetch);
      held = ledger;
      try {
        consumerTag = await startConsumer({
          connection,
          channel,
          held: ledger,
          queue,
          prefetch,
          onDelivery,
          onServerCancel: () => {
            const tag = consumerTag;
            consumerTag = undefined;
            connection.emit({ type: 'server-cancel', consumerTag: tag ?? '' });
          },
        });
      } catch (error) {
        consumer = undefined;
        held = undefined;
        throw error;
      }
      return { consumerTag };
    },

    ackTap(tag: bigint, multiple: boolean): void {
      live();
      if (typeof multiple !== 'boolean') {
        throw invalid('multiple must be a boolean');
      }
      if (consumer === undefined || held === undefined) {
        throw new Amqp091Error(
          'unknown-delivery-tag',
          'nothing has been delivered on this lease',
        );
      }
      consumer.throwIfGone();
      held.require(tag);
      consumer.raw.ack({ fields: { deliveryTag: toWireTag(tag) } }, multiple);
      if (multiple) held.settleUpTo(tag);
      else held.settle(tag);
    },

    release(): Promise<void> {
      released ??= (async () => {
        try {
          // Tap queues are exclusive and auto-delete: the broker removes them with the connection,
          // and what a tap still held is its own copy.
          if (consumer !== undefined && consumerTag !== undefined) {
            await consumer.raw.cancel(consumerTag).catch(() => undefined);
          }
          await consumer?.close(connection.operationTimeoutMs);
          await control?.close(connection.operationTimeoutMs);
        } finally {
          await connection.close('graceful');
        }
      })();
      return released;
    },
  };
  return Object.freeze(lease);
}
