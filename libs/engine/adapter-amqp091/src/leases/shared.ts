// What the leases have in common: argument checks, the consumer wiring of the source and observe
// roles, and the return path of a nack (the barrier). Nothing here is exported from the package.
import type { Delivery } from '@app/ports';

import type { Amqp091Connection } from '../connect.ts';
import { TrackedChannel, withTimeout } from '../channel.ts';
import type { AmqpMessage } from '../driver.ts';
import { Amqp091Error } from '../errors.ts';
import { toDelivery } from '../headers.ts';
import { fromWireTag, TagLedger } from '../proofs.ts';

export const MAX_PREFETCH = 10_000;
/** Channels a lease may have open at once for passive declares (I-6). */
export const MAX_THROWAWAY = 4;
/** The default cap on deliveries held by one peek lease (the peek caps stop at 500). */
export const DEFAULT_MAX_HELD = 1_000;

export function requireName(value: unknown, what: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value) > 255 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Amqp091Error(
      'invalid-argument',
      `${what} must be 1 to 255 bytes without control characters`,
    );
  }
  return value;
}

/** A routing or binding key may be empty (fanout, default exchange). */
export function requireKey(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 255) {
    throw new Amqp091Error(
      'invalid-argument',
      'a routing key must be a string of at most 255 bytes',
    );
  }
  return value;
}

/** An exchange name may be empty (the default exchange); a queue name may not. */
export function requireExchange(value: unknown): string {
  return value === '' ? '' : requireName(value, 'the exchange name');
}

export function requirePrefetch(value: unknown, min: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > MAX_PREFETCH
  ) {
    throw new Amqp091Error(
      'invalid-argument',
      `prefetch must be an integer from ${String(min)} to ${String(MAX_PREFETCH)}`,
    );
  }
  return value;
}

/** The refusal for a `release` argument that is neither state; `release` returns it rejected. */
export function badReleaseState(state: unknown): Amqp091Error | undefined {
  return state === 'healthy' || state === 'poisoned'
    ? undefined
    : new Amqp091Error(
        'invalid-argument',
        'release takes "healthy" or "poisoned"',
      );
}

/**
 * A `basic.qos` round trip on the channel that processed a nack. The broker answers it only after
 * everything sent before it on that channel has been handled, so when this resolves the nacked
 * messages are back on their queue (DC-04). It rejects when the channel is lost: then the hold's
 * outcome is the broker's DOWN handling, and the caller must treat the lease as poisoned.
 */
export async function barrier(
  connection: Amqp091Connection,
  channel: TrackedChannel,
  prefetch: number,
): Promise<void> {
  // A channel the adapter gave up on is still worth a barrier: it holds deliveries to return.
  channel.throwIfGone();
  try {
    await withTimeout(
      channel.raw.prefetch(prefetch, false),
      connection.operationTimeoutMs,
      'the qos barrier',
    );
  } catch (error) {
    const cause = channel.explain(error, 'the qos barrier');
    channel.abandon(cause);
    throw new Amqp091Error(
      'barrier-failed',
      `the qos barrier did not complete (${cause.reason}); the held deliveries were not confirmed returned`,
      { cause, code: cause.code },
    );
  }
}

export interface ConsumerWiring {
  readonly connection: Amqp091Connection;
  readonly channel: TrackedChannel;
  readonly held: TagLedger;
  readonly queue: string;
  readonly prefetch: number;
  readonly onDelivery: (delivery: Delivery | null) => void;
  /** Called when the broker cancels the consumer. */
  readonly onServerCancel: () => void;
}

/**
 * `basic.qos`, then `basic.consume` with manual acknowledgement. The qos comes first so the
 * broker never sends more than `prefetch` unacknowledged messages. Every delivery is recorded in
 * the ledger before the callback runs, so it can be settled; a callback that throws leaves it held
 * and is reported as an event, never swallowed silently.
 */
export async function startConsumer(wiring: ConsumerWiring): Promise<string> {
  const { connection, channel, held, queue, prefetch } = wiring;
  try {
    await withTimeout(
      channel.raw.prefetch(prefetch, false),
      connection.operationTimeoutMs,
      'setting the prefetch',
    );
    const ok = await withTimeout(
      channel.raw.consume(
        queue,
        (message: AmqpMessage | null) => {
          if (message === null) {
            wiring.onServerCancel();
            safely(connection, () => {
              wiring.onDelivery(null);
            });
            return;
          }
          const tag = fromWireTag(message.fields.deliveryTag);
          try {
            held.add(tag);
          } catch (error) {
            // The broker sent more than the prefetch allows. The message cannot be recorded, so
            // the channel is abandoned: it goes back through the broker's DOWN handling.
            const lost =
              error instanceof Amqp091Error
                ? error
                : new Amqp091Error('broker-error', 'a delivery was refused');
            channel.abandon(lost);
            connection.emit({ type: 'channel-error', error: lost });
            return;
          }
          safely(connection, () => {
            wiring.onDelivery(toDelivery(message, tag));
          });
        },
        { noAck: false },
      ),
      connection.operationTimeoutMs,
      'starting the consumer',
    );
    return ok.consumerTag;
  } catch (error) {
    throw channel.explain(error, 'starting the consumer');
  }
}

function safely(connection: Amqp091Connection, run: () => void): void {
  try {
    run();
  } catch {
    connection.emit({ type: 'handler-error' });
  }
}
