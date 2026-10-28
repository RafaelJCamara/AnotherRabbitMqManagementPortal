// A channel the adapter opened, with what went wrong on it. A 0-9-1 channel error closes the
// channel (DC-11), and the deliveries it held go back to their queue through the broker's DOWN
// handling, so the leases need to know that a channel is lost and why, and must never be handed a
// raw channel by anyone else: the raw channel stays inside this class and the leases.
import type { AmqpChannel } from './driver.ts';
import { Amqp091Error, mapAmqplibError } from './errors.ts';

/** Something a subscriber to a connection may want to know. Carries no message content. */
export type ConnectionEvent =
  | { readonly type: 'blocked'; readonly reason: string }
  | { readonly type: 'unblocked' }
  | {
      readonly type: 'closed';
      readonly error?: Amqp091Error;
      /** The broker's reply code when it closed the connection (320 when a token ran out). */
      readonly code?: number | string;
    }
  | { readonly type: 'channel-error'; readonly error: Amqp091Error }
  /** The broker cancelled a consumer (queue deleted, node lost). Its deliveries may still be held. */
  | { readonly type: 'server-cancel'; readonly consumerTag: string }
  /** A consumer callback threw. The delivery stays held until it is settled. */
  | { readonly type: 'handler-error' }
  /** `release('healthy')` found held deliveries on a peek and returned them (nack, barrier). */
  | { readonly type: 'release-flush'; readonly count: number };

export type Emit = (event: ConnectionEvent) => void;

/** Rejects with a `timeout` error if `promise` has not settled after `ms`; the promise runs on. */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Amqp091Error(
          'timeout',
          `${what} did not finish within ${String(ms)} ms`,
        ),
      );
    }, ms);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export class TrackedChannel {
  readonly raw: AmqpChannel;
  #lost: Amqp091Error | undefined;
  #closing = false;
  /** The channel is closed on the wire (the broker closed it, or the connection went). */
  #gone = false;

  constructor(raw: AmqpChannel, emit: Emit) {
    this.raw = raw;
    // A channel without an 'error' listener would crash the process on the first broker error.
    raw.on('error', (error) => {
      const mapped = mapAmqplibError(error, 'the channel');
      this.#lost ??= mapped;
      this.#gone = true;
      emit({ type: 'channel-error', error: mapped });
    });
    raw.on('close', () => {
      this.#gone = true;
      if (!this.#closing) {
        this.#lost ??= new Amqp091Error(
          'channel-closed',
          'the channel was closed',
        );
      }
    });
  }

  /**
   * Why the channel may take no new work (a `get`, a consume, a publish), if it may not. A channel
   * the adapter gave up on (a reply that never came) is lost but not yet gone: settling what it
   * holds still works, and is the only way to return those deliveries without a DOWN.
   */
  get lost(): Amqp091Error | undefined {
    return this.#lost;
  }

  /** The channel is closed on the wire: nothing more can be sent on it. */
  get gone(): boolean {
    return this.#gone;
  }

  throwIfLost(): void {
    if (this.#lost !== undefined) throw this.#lost;
  }

  /** For settling: a lost channel can still settle, a gone one cannot. */
  throwIfGone(): void {
    if (this.#gone) {
      throw (
        this.#lost ??
        new Amqp091Error('channel-closed', 'the channel is closed')
      );
    }
  }

  /** The channel's own error when it has one (it is the cause), else the mapped `error`. */
  explain(error: unknown, context: string): Amqp091Error {
    return this.#lost ?? mapAmqplibError(error, context);
  }

  /** Marks the channel lost for a reason of the adapter's own (a timed-out reply, for example). */
  abandon(error: Amqp091Error): void {
    this.#lost ??= error;
  }

  /** Closes politely; never throws, and gives up after `timeoutMs`. */
  async close(timeoutMs: number): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    if (this.#gone) return;
    try {
      await withTimeout(this.raw.close(), timeoutMs, 'closing the channel');
    } catch {
      // The channel or the whole connection is already going away; there is nothing to do.
    }
  }
}
