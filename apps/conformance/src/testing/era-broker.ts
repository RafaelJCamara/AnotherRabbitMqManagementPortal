// An in-memory quorum-queue broker that behaves, for the actions the lab-cell scenarios use, as the
// registry's cells and the fact sheet say it does in one era. It exists so scenarios and projections
// can be exercised in unit tests without Docker (M0-40).
//
// It encodes the registry's claims. A scenario that passes against it proves the plumbing and
// NOTHING about RabbitMQ: only evidence recorded by CI on a real lab broker proves a broker fact.
// It is test code; nothing in the recorder uses it.
import type {
  RawDelivery,
  SettleAction,
  SettleOutcome,
} from '../driver/amqp091-raw.ts';
import type { RecordHost } from '../record/record.ts';

export type Era = '3.13' | '4.0-4.2' | '4.3';

/** One lab version per era, the one the unit tests stamp their artefacts with. */
export const ERA_VERSION: Readonly<Record<Era, string>> = {
  '3.13': '3.13.7',
  '4.0-4.2': '4.2.9',
  '4.3': '4.3.6',
};

/** What the registry says a returned (`nack` with requeue) quorum message does, per era. */
const BEHAVIOUR: Readonly<
  Record<Era, { countsAsDelivery: boolean; unlimitedReturnsToTail: boolean }>
> = {
  '3.13': { countsAsDelivery: true, unlimitedReturnsToTail: true },
  '4.0-4.2': { countsAsDelivery: false, unlimitedReturnsToTail: false },
  '4.3': { countsAsDelivery: false, unlimitedReturnsToTail: false },
};

interface Stored {
  readonly id: string;
  /** A counter the publisher copied into the message. */
  readonly copied: number | null;
  /** Returns counted as delivery count (3.13) or as acquired count (4.x). */
  returns: number;
  redelivered: boolean;
}

interface Queue {
  readonly limitArgument: boolean;
  ready: Stored[];
}

export interface EraBrokerOptions {
  /** What happens to a copied `x-delivery-count` once the message has been returned. */
  readonly copiedAfterReturn?: 'replaced' | 'kept';
  /** A message id whose counters the broker gets wrong, so a test can prove a projection ignores it. */
  readonly skewed?: string;
}

export class EraBroker implements RecordHost {
  readonly queues = new Map<string, Queue>();
  readonly #held = new Map<number, { queue: string; message: Stored }>();
  #tag = 0;

  constructor(
    readonly era: Era,
    private readonly options: EraBrokerOptions = {},
  ) {}

  brokerVersion(): Promise<string | null> {
    return Promise.resolve(ERA_VERSION[this.era]);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  openConnection(): Promise<void> {
    return Promise.resolve();
  }
  closeConnection(): Promise<void> {
    return Promise.resolve();
  }
  readyCount(queue: string): Promise<number> {
    return Promise.resolve(this.queues.get(queue)?.ready.length ?? 0);
  }
  openChannel(): Promise<void> {
    return Promise.resolve();
  }
  closeChannel(): Promise<void> {
    return Promise.resolve();
  }
  declareQueue(
    queue: string,
    options: { arguments: Readonly<Record<string, unknown>> },
  ): Promise<void> {
    this.queues.set(queue, {
      limitArgument: 'x-delivery-limit' in options.arguments,
      ready: [],
    });
    return Promise.resolve();
  }
  deleteQueue(queue: string): Promise<void> {
    this.queues.delete(queue);
    return Promise.resolve();
  }
  declareExchange(): Promise<void> {
    return Promise.resolve();
  }
  deleteExchange(): Promise<void> {
    return Promise.resolve();
  }
  bindQueue(): Promise<void> {
    return Promise.resolve();
  }
  publish(
    queue: string,
    message: {
      messageId: string;
      headers?: { 'x-delivery-count'?: number };
    },
  ): Promise<void> {
    this.queues.get(queue)?.ready.push({
      id: message.messageId,
      copied: message.headers?.['x-delivery-count'] ?? null,
      returns: 0,
      redelivered: false,
    });
    return Promise.resolve();
  }
  get(
    _channel: string,
    queue: string,
    noAck: boolean,
  ): Promise<RawDelivery | null> {
    const ready = this.queues.get(queue)?.ready ?? [];
    const message = ready.shift();
    if (message === undefined) return Promise.resolve(null);
    this.#tag += 1;
    if (!noAck) this.#held.set(this.#tag, { queue, message });
    return Promise.resolve(this.#deliver(this.#tag, message, ready.length));
  }
  async consume(
    channel: string,
    queue: string,
    count: number,
  ): Promise<RawDelivery[]> {
    const taken: RawDelivery[] = [];
    for (let n = 0; n < count; n += 1) {
      const delivery = await this.get(channel, queue, false);
      if (delivery !== null) taken.push(delivery);
    }
    return taken;
  }
  settle(
    _channel: string,
    tag: number,
    action: SettleAction,
  ): Promise<SettleOutcome> {
    const held = this.#held.get(tag);
    if (held === undefined) {
      return Promise.resolve({
        channelOpen: false,
        closed: {
          code: 406,
          text: 'PRECONDITION_FAILED - unknown delivery tag',
        },
      });
    }
    this.#held.delete(tag);
    const queue = this.queues.get(held.queue);
    if (queue !== undefined && action.kind !== 'ack' && action.requeue) {
      held.message.returns += 1;
      held.message.redelivered = true;
      // 3.13 without a delivery limit puts a returned message at the tail; every other case, at the head.
      if (BEHAVIOUR[this.era].unlimitedReturnsToTail && !queue.limitArgument)
        queue.ready.push(held.message);
      else queue.ready.unshift(held.message);
    }
    return Promise.resolve({ channelOpen: true });
  }
  recover(): Promise<void> {
    return Promise.resolve();
  }
  management(): Promise<{ status: number; json: unknown }> {
    return Promise.resolve({ status: 200, json: {} });
  }

  #deliver(tag: number, message: Stored, left: number): RawDelivery {
    const skew = this.options.skewed === message.id ? 1 : 0;
    const returned = message.returns > 0;
    const keepCopied =
      message.copied !== null &&
      (!returned || this.options.copiedAfterReturn === 'kept');
    const asDelivery = BEHAVIOUR[this.era].countsAsDelivery;
    const stamped = asDelivery ? message.returns : 0;
    return {
      tag,
      redelivered: message.redelivered,
      messageId: message.id,
      bytes: message.id.length,
      messageCount: left,
      xDeliveryCount: keepCopied
        ? message.copied
        : returned
          ? stamped + skew
          : null,
      xAcquiredCount: !asDelivery && returned ? message.returns + skew : null,
    };
  }
}
