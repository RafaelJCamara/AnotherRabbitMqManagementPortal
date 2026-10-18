// Role `source` (ADR-010): the consumer of a replay or move job on a connection of its own, so a
// tap or stream error elsewhere cannot return the DLQ deliveries held here through a DOWN.
//
// Returning a delivery needs a `SafeReturnProof` (checked at run time), because a nack counts as a
// delivery attempt: on a quorum queue with a finite delivery limit it can make the broker drop the
// message. For that reason `release('healthy')` does not return held deliveries on its own, as the
// peek lease does: it refuses while any are held, and the job settles them (ack with a proof, or
// return with a safe-return proof) or poisons the lease and accepts the broker's DOWN handling.
import type { Delivery, SourceLease } from '@app/ports';

import type { Amqp091Connection } from '../connect.ts';
import type { TrackedChannel } from '../channel.ts';
import { Amqp091Error } from '../errors.ts';
import {
  requireAckProof,
  requireSafeReturnProof,
  TagLedger,
  toWireTag,
} from '../proofs.ts';
import {
  badReleaseState,
  barrier,
  requireName,
  requirePrefetch,
  startConsumer,
} from './shared.ts';

/** The lease is bounded by the prefetch of `consume`, so it takes no options. */
export function createSourceLease(connection: Amqp091Connection): SourceLease {
  let held: TagLedger | undefined;
  let channel: TrackedChannel | undefined;
  let consumerTag: string | undefined;
  let consuming = false;
  let nacks = 0;
  let nacksCovered = 0;
  let released: Promise<void> | undefined;

  function live(): void {
    if (released !== undefined) {
      throw new Amqp091Error('released', 'the lease was released');
    }
    connection.assertOpen();
  }

  function settleTarget(): { channel: TrackedChannel; held: TagLedger } {
    if (channel === undefined || held === undefined) {
      throw new Amqp091Error(
        'unknown-delivery-tag',
        'nothing has been delivered on this lease',
      );
    }
    channel.throwIfGone();
    return { channel, held };
  }

  const lease: SourceLease = {
    async consume(
      queue: string,
      prefetch: number,
      onDelivery: (delivery: Delivery | null) => void,
    ): Promise<{ consumerTag: string }> {
      live();
      requireName(queue, 'the queue name');
      requirePrefetch(prefetch, 1);
      if (typeof onDelivery !== 'function') {
        throw new Amqp091Error(
          'invalid-argument',
          'onDelivery must be a function',
        );
      }
      if (consuming) {
        throw new Amqp091Error(
          'busy',
          'a source lease has one consumer (one job per connection)',
        );
      }
      consuming = true;
      const opened = await connection.openChannel();
      channel = opened;
      held = new TagLedger(prefetch);
      try {
        consumerTag = await startConsumer({
          connection,
          channel: opened,
          held,
          queue,
          prefetch,
          onDelivery,
          onServerCancel: () => {
            const tag = consumerTag;
            consumerTag = undefined;
            connection.emit({
              type: 'server-cancel',
              consumerTag: tag ?? '',
            });
          },
        });
      } catch (error) {
        consuming = false;
        throw error;
      }
      return { consumerTag };
    },

    ackWithProof(tag: bigint, proof): void {
      requireAckProof(proof);
      live();
      const target = settleTarget();
      target.held.require(tag);
      target.channel.raw.ack(
        { fields: { deliveryTag: toWireTag(tag) } },
        false,
      );
      target.held.settle(tag);
    },

    nackRequeue(tag: bigint, proof): void {
      requireSafeReturnProof(proof);
      live();
      const target = settleTarget();
      target.held.require(tag);
      target.channel.raw.nack(
        { fields: { deliveryTag: toWireTag(tag) } },
        false,
        true,
      );
      target.held.settle(tag);
      nacks += 1;
    },

    async qosBarrier(prefetch: number): Promise<void> {
      live();
      requirePrefetch(prefetch, 0);
      if (channel === undefined) return;
      const covers = nacks;
      await barrier(connection, channel, prefetch);
      nacksCovered = Math.max(nacksCovered, covers);
    },

    async cancel(tag: string): Promise<void> {
      live();
      requireName(tag, 'the consumer tag');
      if (channel === undefined || consumerTag !== tag) {
        throw new Amqp091Error(
          'not-own-queue',
          'that consumer does not belong to this lease',
        );
      }
      channel.throwIfGone();
      try {
        await channel.raw.cancel(tag);
      } catch (error) {
        throw channel.explain(error, 'cancelling the consumer');
      }
      consumerTag = undefined;
    },

    release(state: 'healthy' | 'poisoned'): Promise<void> {
      const refusal = badReleaseState(state);
      if (refusal !== undefined) return Promise.reject(refusal);
      if (released !== undefined) return released;
      if (state === 'poisoned') {
        released = connection.close('abort');
        return released;
      }
      // A healthy release never closes over held deliveries; the lease stays usable so the job
      // can settle them. This is checked before anything is cancelled or closed.
      const heldCount = held?.size ?? 0;
      if (heldCount > 0) {
        return Promise.reject(
          new Amqp091Error(
            'held-deliveries',
            `${String(heldCount)} deliveries are still held; settle them or release as poisoned`,
          ),
        );
      }
      released = (async () => {
        try {
          if (channel !== undefined && !channel.gone) {
            if (consumerTag !== undefined) {
              await channel.raw.cancel(consumerTag).catch(() => undefined);
              consumerTag = undefined;
            }
            if (nacks > nacksCovered) await barrier(connection, channel, 0);
            await channel.close(connection.operationTimeoutMs);
          }
          await connection.close('graceful');
        } catch (error) {
          await connection.close('abort');
          throw error;
        }
      })();
      return released;
    },
  };
  return Object.freeze(lease);
}
