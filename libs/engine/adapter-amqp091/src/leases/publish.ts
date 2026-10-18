// Role `publish` (DC-12): confirm channels only, every publish `mandatory`, and the one place in
// the engine where a `ConfirmedCopyProof` is minted (A-9). A proof exists only when the broker
// confirmed the message AND did not return it: a confirm that follows a `basic.return` (nothing
// routed it) is not a copy, and a nack, a timeout, a blocked connection or a lost channel never
// yield one.
//
// Publishes run one at a time on a lease. With a `mandatory` publish the broker sends the return
// before the confirm on the same channel, so with a single publish in flight the return belongs to
// it without any correlation id (OQ-213 has the cost).
import type { PublishLease, PublishOutcome } from '@app/ports';
import { mintConfirmedCopyProof } from '@app/ports';

import type { Amqp091Connection } from '../connect.ts';
import { TrackedChannel } from '../channel.ts';
import { Amqp091Error, safeText } from '../errors.ts';
import { fromTypedHeaders } from '../headers.ts';
import { requireExchange, requireName } from './shared.ts';

const MAX_TIMEOUT_MS = 600_000;
/** Properties a publisher may set. Anything else (mandatory, CC, BCC, ...) is refused. */
const TEXT_PROPERTIES = [
  'contentType',
  'contentEncoding',
  'correlationId',
  'replyTo',
  'messageId',
  'type',
  'userId',
  'appId',
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * The AMQP basic properties for amqplib. Only the properties of a message are accepted; the flags
 * that change routing or delivery (`mandatory`, `CC`, `BCC`, `immediate`) can neither be set nor
 * switched off from here.
 */
export function toPublishOptions(
  props: Record<string, unknown>,
): Record<string, unknown> {
  if (!isRecord(props)) {
    throw new Amqp091Error('invalid-argument', 'props must be an object');
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(props)) {
    const value = props[key];
    if (value === undefined) continue;
    if ((TEXT_PROPERTIES as readonly string[]).includes(key)) {
      if (typeof value !== 'string' || value.length > 255) {
        throw new Amqp091Error(
          'invalid-argument',
          `the property ${key} must be a string of at most 255 characters`,
        );
      }
      out[key] = value;
    } else if (key === 'deliveryMode') {
      if (value !== 1 && value !== 2) {
        throw new Amqp091Error('invalid-argument', 'deliveryMode is 1 or 2');
      }
      out[key] = value;
    } else if (key === 'priority') {
      if (
        !Number.isInteger(value) ||
        (value as number) < 0 ||
        (value as number) > 255
      ) {
        throw new Amqp091Error('invalid-argument', 'priority is 0 to 255');
      }
      out[key] = value;
    } else if (key === 'timestamp') {
      if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new Amqp091Error(
          'invalid-argument',
          'timestamp is a non-negative integer',
        );
      }
      out[key] = value;
    } else if (key === 'expiration') {
      if (typeof value !== 'string' && typeof value !== 'number') {
        throw new Amqp091Error(
          'invalid-argument',
          'expiration is a string or a number',
        );
      }
      out[key] = String(value);
    } else if (key === 'headers') {
      if (!isRecord(value)) {
        throw new Amqp091Error('invalid-argument', 'headers must be a table');
      }
      out[key] = fromTypedHeaders(
        value as Parameters<typeof fromTypedHeaders>[0],
      );
    } else if (key !== 'clusterId') {
      // `clusterId` is deprecated and amqplib cannot publish it; a delivery's properties may carry it.
      throw new Amqp091Error(
        'invalid-argument',
        `the property ${safeText(key, 40)} cannot be set on a publish`,
      );
    }
  }
  return out;
}

/** Where a copy went, as the proof names it: the queue for the default exchange. */
function destinationOf(exchange: string, routingKey: string): string {
  return exchange === '' ? routingKey : `${exchange}/${routingKey}`;
}

/** What the broker said when it returned the message in flight (`basic.return`). */
class ReturnWatch {
  #text: string | undefined;

  reset(): void {
    this.#text = undefined;
  }

  record(text: string): void {
    this.#text = text;
  }

  /** The reason of the return, if the message in flight was returned. */
  seen(): string | undefined {
    return this.#text;
  }
}

function isMandatory(options: unknown): options is { timeoutMs: unknown } {
  return isRecord(options) && options.mandatory === true;
}

export function createPublishLease(
  connection: Amqp091Connection,
): PublishLease {
  let confirming: TrackedChannel | undefined;
  const returns = new ReturnWatch();
  let tail: Promise<unknown> = Promise.resolve();
  let released: Promise<void> | undefined;

  function live(): void {
    if (released !== undefined) {
      throw new Amqp091Error('released', 'the lease was released');
    }
    connection.assertOpen();
  }

  async function confirmChannel(): Promise<TrackedChannel> {
    if (confirming !== undefined && confirming.lost === undefined) {
      return confirming;
    }
    const channel = await connection.openConfirmChannel();
    channel.raw.on('return', (message) => {
      // A late return from a channel we dropped must not be taken for the next publish's.
      if (confirming !== channel) return;
      returns.record(
        safeText(message.fields.replyText ?? 'returned by the broker', 120),
      );
    });
    confirming = channel;
    return channel;
  }

  async function publishOne(
    exchange: string,
    routingKey: string,
    body: Uint8Array,
    props: Record<string, unknown>,
    options: { mandatory: true; timeoutMs: number },
  ): Promise<PublishOutcome> {
    live();
    requireExchange(exchange);
    if (typeof routingKey !== 'string' || Buffer.byteLength(routingKey) > 255) {
      throw new Amqp091Error(
        'invalid-argument',
        'the routing key must be at most 255 bytes',
      );
    }
    if (exchange === '') requireName(routingKey, 'the queue name');
    if (!(body instanceof Uint8Array)) {
      throw new Amqp091Error(
        'invalid-argument',
        'the body must be a Uint8Array',
      );
    }
    // `mandatory` is not a choice: an unroutable copy must come back as a return, not vanish.
    if (!isMandatory(options)) {
      throw new Amqp091Error(
        'forbidden-settle',
        'a publish is always mandatory',
      );
    }
    const timeoutMs = options.timeoutMs;
    if (
      typeof timeoutMs !== 'number' ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_TIMEOUT_MS
    ) {
      throw new Amqp091Error(
        'invalid-argument',
        `timeoutMs must be an integer from 1 to ${String(MAX_TIMEOUT_MS)}`,
      );
    }
    const amqpProps = toPublishOptions(props);

    // Blocked: nothing is sent, so nothing can be confirmed later by surprise.
    if (connection.blocked.isBlocked()) {
      return {
        outcome: 'blocked',
        reason:
          connection.blocked.snapshot().reason ?? 'the connection is blocked',
      };
    }

    const channel = await confirmChannel();
    channel.throwIfLost();
    returns.reset();

    type Result =
      | { kind: 'confirmed' }
      | { kind: 'nacked' }
      | { kind: 'failed'; error: unknown }
      | { kind: 'timeout' };
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race<Result>([
      new Promise<Result>((resolve) => {
        try {
          channel.raw.publish(
            exchange,
            routingKey,
            Buffer.from(body.buffer, body.byteOffset, body.byteLength),
            { ...amqpProps, mandatory: true },
            (error) => {
              if (error === null || error === undefined) {
                resolve({ kind: 'confirmed' });
              } else if (
                error instanceof Error &&
                error.message === 'message nacked'
              ) {
                resolve({ kind: 'nacked' });
              } else {
                resolve({ kind: 'failed', error });
              }
            },
          );
        } catch (error) {
          resolve({ kind: 'failed', error });
        }
      }),
      new Promise<Result>((resolve) => {
        timer = setTimeout(() => {
          resolve({ kind: 'timeout' });
        }, timeoutMs);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);

    switch (result.kind) {
      case 'confirmed':
        {
          // The broker took the message and found no queue for it: there is no copy.
          const reason = returns.seen();
          if (reason !== undefined) return { outcome: 'returned', reason };
        }
        return {
          outcome: 'confirmed',
          proof: mintConfirmedCopyProof({
            destination: destinationOf(exchange, routingKey),
            confirmedAt: connection.now(),
          }),
        };
      case 'nacked':
        return { outcome: 'nacked', reason: 'the broker nacked the message' };
      case 'timeout': {
        // A late confirm must not be taken for the next publish's: drop the channel.
        const abandoned = confirming;
        confirming = undefined;
        if (abandoned !== undefined) {
          abandoned.abandon(
            new Amqp091Error(
              'timeout',
              'a publish confirm did not arrive in time',
            ),
          );
          void abandoned.close(connection.operationTimeoutMs);
        }
        return connection.blocked.isBlocked()
          ? {
              outcome: 'blocked',
              reason:
                connection.blocked.snapshot().reason ??
                'the connection is blocked',
            }
          : { outcome: 'timeout', reason: 'no confirm within the time limit' };
      }
      case 'failed':
        throw channel.explain(result.error, 'a publish');
    }
  }

  const lease: PublishLease = {
    publish(exchange, routingKey, body, props, options) {
      // One publish at a time: a failed one must not poison the next one's wait.
      const run = tail.then(
        () => publishOne(exchange, routingKey, body, props, options),
        () => publishOne(exchange, routingKey, body, props, options),
      );
      tail = run.catch(() => undefined);
      return run;
    },

    blocked: () => connection.blocked.isBlocked(),

    release(): Promise<void> {
      released ??= (async () => {
        await tail.catch(() => undefined);
        await confirming?.close(connection.operationTimeoutMs);
        await connection.close('graceful');
      })();
      return released;
    },
  };
  return Object.freeze(lease);
}
