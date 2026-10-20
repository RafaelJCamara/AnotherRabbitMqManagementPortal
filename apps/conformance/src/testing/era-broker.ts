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
import { runScenario, type LabScenario, type RunClock } from '../dsl.ts';
import { sealArtefact, type EvidenceArtefact } from '../record/evidence.ts';
import type { RecordHost } from '../record/record.ts';
import { DIGEST, localProvenance } from './lab.ts';

export type Era = '3.13' | '4.0-4.2' | '4.3';

/** One lab version per era, the one the unit tests stamp their artefacts with. */
export const ERA_VERSION: Readonly<Record<Era, string>> = {
  '3.13': '3.13.7',
  '4.0-4.2': '4.2.9',
  '4.3': '4.3.6',
};

interface Behaviour {
  /** A return counts as a delivery (3.13) rather than as an acquisition (4.x). */
  countsAsDelivery: boolean;
  unlimitedReturnsToTail: boolean;
  /** A `reject` with requeue also raises the delivery count (4.3 only, fact sheet b.2). */
  rejectRaisesDc: boolean;
  /** The counter the delivery limit is compared with. */
  limitCounter: 'ac' | 'dc';
  /** The limit of a quorum queue that sets none; 3.13 has none. */
  defaultLimit: number | null;
  /** A dead letter keeps the counters of its source (4.3, fact sheet b.4); otherwise it starts afresh. */
  carries: boolean;
  /** The queue argument x-delayed-retry-type exists (4.3, fact sheet b.5); older eras ignore it. */
  delayedRetry: boolean;
}

/** What the registry says a returned or dead-lettered quorum message does, per era. */
const BEHAVIOUR: Readonly<Record<Era, Behaviour>> = {
  '3.13': {
    countsAsDelivery: true,
    unlimitedReturnsToTail: true,
    rejectRaisesDc: false,
    limitCounter: 'dc',
    defaultLimit: null,
    carries: false,
    delayedRetry: false,
  },
  '4.0-4.2': {
    countsAsDelivery: false,
    unlimitedReturnsToTail: false,
    rejectRaisesDc: false,
    limitCounter: 'ac',
    defaultLimit: 20,
    carries: false,
    delayedRetry: false,
  },
  '4.3': {
    countsAsDelivery: false,
    unlimitedReturnsToTail: false,
    rejectRaisesDc: true,
    limitCounter: 'dc',
    defaultLimit: 20,
    carries: true,
    delayedRetry: true,
  },
};

interface Stored {
  readonly id: string;
  /** A counter the publisher copied into the message. */
  readonly copied: number | null;
  /** The acquired count and the delivery count the broker keeps for the message. */
  ac: number;
  dc: number;
  redelivered: boolean;
}

interface Queue {
  readonly limitArgument: boolean;
  readonly limit: number | null;
  readonly dlx: string | null;
  readonly dlk: string | null;
  readonly retry: { type: string; min: number; max: number } | null;
  ready: Stored[];
  /** Returned messages that are invisible until the virtual clock reaches t. */
  delayed: { message: Stored; at: number }[];
}

export interface EraBrokerOptions {
  /** What happens to a copied `x-delivery-count` once the message has been returned. */
  readonly copiedAfterReturn?: 'replaced' | 'kept';
  /** A message id whose counters the broker gets wrong, so a test can prove a projection ignores it. */
  readonly skewed?: string;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

export class EraBroker implements RecordHost {
  readonly queues = new Map<string, Queue>();
  /** Exchange to binding key to the queues bound with it. */
  readonly exchanges = new Map<string, Map<string, string[]>>();
  readonly #held = new Map<number, { queue: string; message: Stored }>();
  #tag = 0;
  #now = 1_700_000_000_000;
  /** Virtual time: a wait moves it, nothing really sleeps, and 
ext_delayed_at is read against it. */
  readonly clock: RunClock = {
    now: () => this.#now,
    sleep: (ms) => {
      this.#now += ms;
      return Promise.resolve();
    },
  };

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
    const { arguments: args } = options;
    const limit = args['x-delivery-limit'];
    const min = args['x-delayed-retry-min'];
    const max = args['x-delayed-retry-max'];
    const type = text(args['x-delayed-retry-type']);
    this.queues.set(queue, {
      limitArgument: 'x-delivery-limit' in args,
      limit: typeof limit === 'number' ? limit : null,
      dlx: text(args['x-dead-letter-exchange']),
      dlk: text(args['x-dead-letter-routing-key']),
      retry:
        BEHAVIOUR[this.era].delayedRetry && type !== null && type !== 'disabled'
          ? {
              type,
              min: typeof min === 'number' ? min : 0,
              max:
                typeof max === 'number'
                  ? max
                  : typeof min === 'number'
                    ? min
                    : 0,
            }
          : null,
      ready: [],
      delayed: [],
    });
    return Promise.resolve();
  }
  deleteQueue(queue: string): Promise<void> {
    this.queues.delete(queue);
    return Promise.resolve();
  }
  declareExchange(exchange: string): Promise<void> {
    this.exchanges.set(exchange, new Map());
    return Promise.resolve();
  }
  deleteExchange(exchange: string): Promise<void> {
    this.exchanges.delete(exchange);
    return Promise.resolve();
  }
  bindQueue(queue: string, exchange: string, key: string): Promise<void> {
    const bindings = this.exchanges.get(exchange);
    bindings?.set(key, [...(bindings.get(key) ?? []), queue]);
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
      ac: 0,
      dc: 0,
      redelivered: false,
    });
    return Promise.resolve();
  }
  get(
    _channel: string,
    queue: string,
    noAck: boolean,
  ): Promise<RawDelivery | null> {
    const ready = this.#release(queue);
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
    if (queue === undefined || action.kind === 'ack') {
      return Promise.resolve({ channelOpen: true });
    }
    const rules = BEHAVIOUR[this.era];
    if (!action.requeue) {
      this.#deadLetter(queue, held.message, true);
      return Promise.resolve({ channelOpen: true });
    }
    const { message } = held;
    if (rules.countsAsDelivery) message.dc += 1;
    else message.ac += 1;
    if (action.kind === 'reject' && rules.rejectRaisesDc) message.dc += 1;
    message.redelivered = true;
    const limit = queue.limit ?? rules.defaultLimit;
    if (limit !== null && message[rules.limitCounter] > limit) {
      this.#deadLetter(queue, message, false);
    } else if (this.#delay(queue, message, action.kind === 'reject')) {
      // Invisible until its delay has passed.
    } else if (rules.unlimitedReturnsToTail && !queue.limitArgument) {
      // 3.13 without a delivery limit puts a returned message at the tail; every other case, at the head.
      queue.ready.push(message);
    } else queue.ready.unshift(message);
    return Promise.resolve({ channelOpen: true });
  }
  recover(): Promise<void> {
    return Promise.resolve();
  }
  /** GET /api/queues/%2F/<q> (counts) and POST .../get with ck_requeue_true (a nack-and-requeue read). */
  management(call: {
    method: string;
    path: string;
  }): Promise<{ status: number; json: unknown }> {
    const found = /^\/api\/queues\/%2F\/([^/]+)(\/get)?$/.exec(call.path);
    const name = found?.[1] === undefined ? '' : decodeURIComponent(found[1]);
    const queue = this.queues.get(name);
    if (queue === undefined) return Promise.resolve({ status: 404, json: {} });
    const ready = this.#release(name);
    if (found?.[2] === undefined) {
      const first = queue.delayed
        .map((item) => item.at)
        .sort((a, b) => a - b)[0];
      return Promise.resolve({
        status: 200,
        json: {
          messages_ready: ready.length,
          messages_unacknowledged: this.#held.size,
          ...(BEHAVIOUR[this.era].delayedRetry
            ? {
                messages_delayed: queue.delayed.length,
                ...(first === undefined ? {} : { next_delayed_at: first }),
              }
            : {}),
        },
      });
    }
    // The read takes the head message and returns it: one acquisition, and a non-failed return.
    const message = ready.shift();
    if (message === undefined)
      return Promise.resolve({ status: 200, json: [] });
    message.ac += 1;
    message.redelivered = true;
    if (!this.#delay(queue, message, false)) ready.unshift(message);
    return Promise.resolve({
      status: 200,
      json: [
        {
          redelivered: false,
          payload_bytes: message.id.length,
          message_count: ready.length,
          properties: { message_id: message.id },
        },
      ],
    });
  }

  /** The ready list of a queue after the messages whose delay has passed are back at its head. */
  #release(name: string): Stored[] {
    const queue = this.queues.get(name);
    if (queue === undefined) return [];
    const due = queue.delayed.filter((item) => item.at <= this.#now);
    queue.delayed = queue.delayed.filter((item) => item.at > this.#now);
    queue.ready.unshift(...due.map((item) => item.message));
    return queue.ready;
  }

  /** Delays a returned message when the queue's delayed-retry type covers this kind of return (fact sheet b.5). */
  #delay(queue: Queue, message: Stored, failed: boolean): boolean {
    const { retry } = queue;
    if (
      retry === null ||
      (retry.type === 'failed' ? !failed : retry.type === 'returned' && failed)
    ) {
      return false;
    }
    // min x max(1, DC), capped at max.
    const delay = Math.min(retry.min * Math.max(1, message.dc), retry.max);
    queue.delayed.push({ message, at: this.#now + delay });
    return true;
  }

  /**
   * Routes the message to the queue's dead-letter exchange, or drops it when it has none. A dead
   * letter carries its counters on 4.3 (and, when `settled`, one more of each for the settle), and
   * starts afresh on 3.13 and 4.0-4.2.
   */
  #deadLetter(queue: Queue, message: Stored, settled: boolean): void {
    if (queue.dlx === null) return;
    const carried = BEHAVIOUR[this.era].carries;
    const bump = settled ? 1 : 0;
    for (const name of this.exchanges.get(queue.dlx)?.get(queue.dlk ?? '') ??
      []) {
      this.queues.get(name)?.ready.push({
        id: message.id,
        copied: null,
        ac: carried ? message.ac + bump : 0,
        dc: carried ? message.dc + bump : 0,
        redelivered: false,
      });
    }
  }

  #deliver(tag: number, message: Stored, left: number): RawDelivery {
    const skew = this.options.skewed === message.id ? 1 : 0;
    const returned = message.ac > 0 || message.dc > 0;
    const keepCopied =
      message.copied !== null &&
      (!returned || this.options.copiedAfterReturn === 'kept');
    return {
      tag,
      redelivered: message.redelivered,
      messageId: message.id,
      bytes: message.id.length,
      messageCount: left,
      xDeliveryCount: keepCopied
        ? message.copied
        : returned
          ? message.dc + skew
          : null,
      xAcquiredCount: message.ac > 0 ? message.ac + skew : null,
    };
  }
}

/** What CI stamps on an artefact it records; a test uses it to fabricate evidence in a temporary folder. */
export const CI_PROVENANCE: EvidenceArtefact['provenance'] = {
  kind: 'ci',
  recorder: 'conformance:record',
  gitSha: 'a'.repeat(40),
  runUrl: 'https://github.com/acme/portal/actions/runs/1/attempts/1',
  workflow:
    'acme/portal/.github/workflows/conformance-record.yml@refs/heads/main',
  recordedAt: '2026-10-19T10:00:00.000Z',
};

/** Runs a scenario on an era broker and seals the artefact a local recorder would write. */
export async function recordOnEra(
  era: Era,
  scenario: LabScenario,
  options?: EraBrokerOptions,
  provenance: EvidenceArtefact['provenance'] = localProvenance,
): Promise<EvidenceArtefact> {
  const broker = new EraBroker(era, options);
  const run = await runScenario(
    broker,
    scenario,
    'r1',
    undefined,
    broker.clock,
  );
  return sealArtefact({
    schemaVersion: 1,
    cfId: scenario.cfId,
    title: scenario.title,
    protocol: 'amqp091',
    brokerVersion: ERA_VERSION[era],
    imageDigest: DIGEST,
    steps: run.steps,
    observations: run.observations,
    provenance,
  });
}
