// Role `peek` (DC-03/04/11, ADR-008, ADR-009): sequential `basic.get` with manual acknowledgement,
// one multiple nack with requeue, a `basic.qos` barrier, and a lazy close. The lease has no way to
// publish, consume, reject or nack without requeue: those methods do not exist, and the ones that
// do exist refuse every argument that would mean them even when the types were bypassed.
//
// What the lease guarantees on top of the types:
//  - `get` throws before sending anything when the queue is a stream or its type is not known
//    (a `basic.get` on a stream is a connection-level 540 that returns every held delivery);
//  - `ackWithProof` checks the proof at run time (`assertAckProof`) before it looks at anything else;
//  - a settle names a tag this lease holds, so the broker never answers 406 and closes the channel;
//  - only one `get` runs at a time (the gets are sequential), and passive declares run on their own
//    throwaway channels, never on the channel that holds deliveries;
//  - `release('healthy')` never closes a channel that still holds deliveries: it returns them
//    (nack, then barrier) first.
import type { QueueType } from '@app/domain-model';
import type {
  Delivery,
  PeekLease,
  QueueCounts,
  ThrowawayChannel,
} from '@app/ports';

import type { Amqp091Connection } from '../connect.ts';
import { TrackedChannel, withTimeout } from '../channel.ts';
import { Amqp091Error } from '../errors.ts';
import { toDelivery } from '../headers.ts';
import {
  fromWireTag,
  requireAckProof,
  TagLedger,
  toWireTag,
} from '../proofs.ts';
import {
  barrier,
  DEFAULT_MAX_HELD,
  MAX_THROWAWAY,
  badReleaseState,
  requireName,
  requirePrefetch,
} from './shared.ts';

/** What the planner learned about a queue from the management API (the preflight). */
export interface QueueTypeLookup {
  /** `undefined` when the type is not known. */
  typeOf(queue: string): QueueType | undefined;
}

export interface PeekLeaseOptions {
  readonly queueTypes: QueueTypeLookup;
  /** Cap on deliveries held at once. Default 1,000; the peek caps stop at 500. */
  readonly maxHeld?: number;
}

function isMultipleRequeue(options: unknown): boolean {
  return (
    typeof options === 'object' &&
    options !== null &&
    (options as { multiple?: unknown }).multiple === true &&
    (options as { requeue?: unknown }).requeue === true
  );
}

export function createPeekLease(
  connection: Amqp091Connection,
  options: PeekLeaseOptions,
): PeekLease {
  const held = new TagLedger(options.maxHeld ?? DEFAULT_MAX_HELD);
  let holding: TrackedChannel | undefined;
  let getting = false;
  let throwaways = 0;
  /** Bumped by every nack; a barrier only settles the debt of the nacks that came before it. */
  let nacks = 0;
  let nacksCovered = 0;
  let released: Promise<void> | undefined;

  function live(): void {
    if (released !== undefined) {
      throw new Amqp091Error('released', 'the lease was released');
    }
    connection.assertOpen();
  }

  /** The channel that holds deliveries; opened by the first `get`, fresh for every lease. */
  async function holdingChannel(): Promise<TrackedChannel> {
    if (holding === undefined) {
      const channel = await connection.openChannel();
      holding = channel;
    }
    return holding;
  }

  function refuseNonPeekable(queue: string): void {
    const type = options.queueTypes.typeOf(queue);
    if (type === 'stream') {
      throw new Amqp091Error(
        'stream-get-refused',
        'basic.get is never sent to a stream (DC-11); use the stream browser',
      );
    }
    if (type === undefined) {
      throw new Amqp091Error(
        'queue-type-unknown',
        'the type of the queue is not known, so basic.get is not sent (it could be a stream)',
      );
    }
  }

  function nackAllUpTo(channel: TrackedChannel, tag: bigint): void {
    channel.raw.nack({ fields: { deliveryTag: toWireTag(tag) } }, true, true);
    held.settleUpTo(tag);
    nacks += 1;
  }

  async function runBarrier(prefetch: number): Promise<void> {
    if (holding === undefined) return;
    const covers = nacks;
    await barrier(connection, holding, prefetch);
    nacksCovered = Math.max(nacksCovered, covers);
  }

  const lease: PeekLease = {
    async get(queue: string): Promise<Delivery | null> {
      live();
      requireName(queue, 'the queue name');
      refuseNonPeekable(queue);
      if (getting) {
        throw new Amqp091Error(
          'busy',
          'a get is already running; gets are sequential on a peek lease',
        );
      }
      if (!held.hasRoom()) {
        throw new Amqp091Error(
          'too-many-held',
          `more than ${String(held.limit)} deliveries are held on this lease`,
        );
      }
      getting = true;
      try {
        const channel = await holdingChannel();
        channel.throwIfLost();
        let message;
        try {
          message = await withTimeout(
            channel.raw.get(queue, { noAck: false }),
            connection.operationTimeoutMs,
            'basic.get',
          );
        } catch (error) {
          const cause = channel.explain(error, 'basic.get');
          // A reply that never came leaves the channel in an unknown state.
          channel.abandon(cause);
          throw cause;
        }
        if (message === false) return null;
        const tag = fromWireTag(message.fields.deliveryTag);
        held.add(tag);
        return toDelivery(message, tag);
      } finally {
        getting = false;
      }
    },

    nackRequeue(
      upToTag: bigint,
      options: { multiple: true; requeue: true },
    ): void {
      live();
      // The types allow nothing else; a caller that got round them is refused here.
      if (!isMultipleRequeue(options)) {
        throw new Amqp091Error(
          'forbidden-settle',
          'a peek returns messages only with multiple=true and requeue=true',
        );
      }
      const channel = holding;
      if (channel === undefined) {
        throw new Amqp091Error(
          'unknown-delivery-tag',
          'nothing has been delivered on this lease',
        );
      }
      // Settling still works on a channel the adapter gave up on; only a closed one cannot.
      channel.throwIfGone();
      held.require(upToTag);
      nackAllUpTo(channel, upToTag);
    },

    async qosBarrier(prefetch: number): Promise<void> {
      live();
      requirePrefetch(prefetch, 0);
      await runBarrier(prefetch);
    },

    ackWithProof(tag: bigint, proof): void {
      // First, before anything is looked up or sent: a forged proof changes nothing.
      requireAckProof(proof);
      live();
      const channel = holding;
      if (channel === undefined) {
        throw new Amqp091Error(
          'unknown-delivery-tag',
          'nothing has been delivered on this lease',
        );
      }
      channel.throwIfGone();
      held.require(tag);
      channel.raw.ack({ fields: { deliveryTag: toWireTag(tag) } }, false);
      held.settle(tag);
    },

    async throwaway<T>(
      fn: (channel: ThrowawayChannel) => Promise<T>,
    ): Promise<T> {
      live();
      if (throwaways >= MAX_THROWAWAY) {
        throw new Amqp091Error(
          'busy',
          `at most ${String(MAX_THROWAWAY)} throwaway channels at once`,
        );
      }
      throwaways += 1;
      let channel: TrackedChannel;
      try {
        channel = await connection.openChannel();
      } catch (error) {
        throwaways -= 1;
        throw error;
      }
      let open = true;
      const facade: ThrowawayChannel = Object.freeze({
        async checkQueue(name: string): Promise<QueueCounts> {
          if (!open) {
            throw new Amqp091Error(
              'released',
              'the throwaway channel is closed',
            );
          }
          requireName(name, 'the queue name');
          channel.throwIfLost();
          try {
            const ok = await withTimeout(
              channel.raw.checkQueue(name),
              connection.operationTimeoutMs,
              'a passive declare',
            );
            return {
              messageCount: ok.messageCount,
              consumerCount: ok.consumerCount,
            };
          } catch (error) {
            throw channel.explain(error, 'a passive declare');
          }
        },
      });
      try {
        return await fn(facade);
      } finally {
        open = false;
        await channel.close(connection.operationTimeoutMs);
        throwaways -= 1;
      }
    },

    release(state: 'healthy' | 'poisoned'): Promise<void> {
      const refusal = badReleaseState(state);
      if (refusal !== undefined) return Promise.reject(refusal);
      released ??= (async () => {
        if (state === 'poisoned') {
          await connection.close('abort');
          return;
        }
        try {
          if (holding !== undefined && !holding.gone) {
            const top = held.highest();
            if (top !== undefined) {
              // Never close a channel that holds deliveries (DC-04, I-4): return them first.
              const count = held.size;
              nackAllUpTo(holding, top);
              connection.emit({ type: 'release-flush', count });
            }
            if (nacks > nacksCovered) await runBarrier(0);
          }
          await holding?.close(connection.operationTimeoutMs);
          await connection.close('graceful');
        } catch (error) {
          // The hold could not be confirmed returned: close hard and tell the caller.
          await connection.close('abort');
          throw error;
        }
      })();
      return released;
    },
  };
  return Object.freeze(lease);
}
