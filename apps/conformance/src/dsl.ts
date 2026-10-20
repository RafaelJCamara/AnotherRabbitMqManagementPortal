// The LabScenario DSL (M0-15): a scenario is data, a list of steps (declare, publish, get, consume,
// settle, observe), checked when it is defined and run against a broker host that does what the
// steps say, including what a product must never do. Running one yields the evidence's `steps` and
// `observations`; nothing in a scenario names a registry cell or reads the registry (ADR-007).
//
// A step records only the fields its operation defines: queue and channel aliases, message ids,
// tags, counts, byte sizes and the broker's answers. Never a body, a header, a URL or a login.
import type {
  Attempt,
  QueueType,
  RawDelivery,
  SettleAction,
  SettleOutcome,
} from './driver/amqp091-raw.ts';
import type { HttpRawResponse } from './driver/http-raw.ts';
import {
  CF_ID,
  type EvidenceObservation,
  type EvidenceStep,
  type Json,
} from './record/evidence.ts';

export type { Attempt, Refusal } from './driver/amqp091-raw.ts';

export type AckMode =
  | 'ack_requeue_true'
  | 'ack_requeue_false'
  | 'reject_requeue_true'
  | 'reject_requeue_false';

/**
 * A reference to a queue or an exchange declared earlier in the same scenario. Wherever an argument
 * or a binding key takes one, it is replaced by the run-unique name when the step runs; the record
 * keeps the alias, so a live replay can equal the evidence.
 */
export interface Ref {
  readonly $ref: string;
}
export const ref = (alias: string): Ref => ({ $ref: alias });
/** A ref as the record keeps it (its alias), a plain value as it is. */
const plain = (value: Json | Ref): Json =>
  isRef(value) ? { $ref: value.$ref } : value;
const isRef = (value: unknown): value is Ref =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === 1 &&
  typeof (value as { $ref?: unknown }).$ref === 'string';

/** The only header a scenario may set on a message: a copied delivery counter (an integer constant). */
export interface CopiedHeaders {
  readonly 'x-delivery-count'?: number;
}

/** The longest fixed wait a step may ask for. */
export const MAX_WAIT_MS = 60_000;

export type LabStep =
  | {
      readonly op: 'declareQueue';
      readonly queue: string;
      readonly type: QueueType;
      readonly durable: boolean;
      /** Owned by `main`; classic and non-durable only. Present only when set, so older records stay as they were. */
      readonly exclusive?: true;
      /** A value may be a `Ref` to an exchange or queue declared earlier (dead-letter topology). */
      readonly arguments: Readonly<Record<string, Json | Ref>>;
    }
  | {
      readonly op: 'declareExchange';
      readonly exchange: string;
      readonly kind: 'direct' | 'fanout';
    }
  | {
      readonly op: 'bindQueue';
      readonly queue: string;
      readonly exchange: string;
      readonly key: string | Ref;
    }
  /** A fixed pause, recorded as an argument: never a measured time. */
  | { readonly op: 'wait'; readonly ms: number }
  /** `GET /api/queues/%2F/<queue>`: counts and the class of `next_delayed_at`, never a clock value. */
  | {
      readonly op: 'mgmtQueue';
      readonly as: string;
      readonly queue: string;
    }
  | { readonly op: 'openConnection'; readonly connection: string }
  /** Graceful: `connection.close` and its reply. Every channel of the connection goes with it. */
  | { readonly op: 'closeConnection'; readonly connection: string }
  | {
      readonly op: 'openChannel';
      readonly channel: string;
      /** The connection the channel opens on; `main` unless a scenario opened another. */
      readonly connection: string;
    }
  | { readonly op: 'closeChannel'; readonly channel: string }
  | {
      readonly op: 'awaitReady';
      readonly queue: string;
      /** Poll the ready count until it has been the same this many polls in a row. */
      readonly stableFor: number;
      /** A hard bound: exceeding it fails the run and records nothing. Never recorded itself. */
      readonly timeoutMs: number;
    }
  | {
      readonly op: 'publish';
      readonly queue: string;
      readonly messageId: string;
      readonly body: string;
      readonly headers?: CopiedHeaders;
    }
  | {
      readonly op: 'get';
      readonly as: string;
      readonly queue: string;
      readonly noAck: boolean;
      readonly channel: string;
    }
  /**
   * A `basic.get` whose refusal is an answer: a reply the broker closed the channel or the
   * connection with is recorded as level, code and reply name (never its text). Anything else that
   * goes wrong, such as a socket error, aborts the run.
   */
  | {
      readonly op: 'tryGet';
      readonly as: string;
      readonly queue: string;
      readonly noAck: boolean;
      readonly channel: string;
    }
  | {
      readonly op: 'consume';
      readonly as: string;
      readonly queue: string;
      readonly count: number;
      readonly channel: string;
      /** Cancel the consumer once the deliveries arrived (the default); `false` leaves it active. */
      readonly cancel: boolean;
    }
  | {
      readonly op: 'settle';
      readonly target: { readonly ref: string } | { readonly tag: number };
      /** Defaults to the channel the delivery came on; name another to settle from the wrong one. */
      readonly channel: string | undefined;
      readonly action: SettleAction;
      /** Skip, and record the skip, when the delivery never came (an earlier get found nothing). */
      readonly optional?: boolean;
    }
  | { readonly op: 'recover'; readonly channel: string }
  | {
      readonly op: 'mgmtGet';
      readonly as: string;
      readonly queue: string;
      readonly count: number;
      readonly ackmode: AckMode;
    }
  | {
      readonly op: 'observe';
      readonly name: string;
      readonly queue: string;
      readonly channel: string;
      /** Aliases of the queues whose published messages may be found here (dead letters arrive from others). */
      readonly from?: readonly string[];
    };

export interface LabScenario {
  readonly cfId: string;
  readonly title: string;
  readonly protocol: 'amqp091';
  readonly steps: readonly LabStep[];
}

const MAIN = 'main';

export const declareQueue = (
  queue: string,
  options: {
    type?: QueueType;
    durable?: boolean;
    /** Classic and non-durable only (checked when the scenario is defined). */
    exclusive?: boolean;
    arguments?: Record<string, Json | Ref>;
  } = {},
): LabStep => ({
  op: 'declareQueue',
  queue,
  type: options.type ?? 'classic',
  durable: options.durable ?? true,
  ...(options.exclusive === true ? { exclusive: true as const } : {}),
  arguments: options.arguments ?? {},
});
export const openConnection = (connection: string): LabStep => ({
  op: 'openConnection',
  connection,
});
export const closeConnection = (connection: string): LabStep => ({
  op: 'closeConnection',
  connection,
});
export const openChannel = (
  channel: string,
  options: { connection?: string } = {},
): LabStep => ({
  op: 'openChannel',
  channel,
  connection: options.connection ?? MAIN,
});
export const closeChannel = (channel: string): LabStep => ({
  op: 'closeChannel',
  channel,
});
export const declareExchange = (
  exchange: string,
  kind: 'direct' | 'fanout' = 'direct',
): LabStep => ({ op: 'declareExchange', exchange, kind });
export const bindQueue = (
  queue: string,
  exchange: string,
  key: string | Ref,
): LabStep => ({ op: 'bindQueue', queue, exchange, key });
export const wait = (ms: number): LabStep => ({ op: 'wait', ms });
export const mgmtQueue = (as: string, queue: string): LabStep => ({
  op: 'mgmtQueue',
  as,
  queue,
});
export const publish = (
  queue: string,
  messageId: string,
  body = messageId,
  options: { headers?: CopiedHeaders } = {},
): LabStep => ({
  op: 'publish',
  queue,
  messageId,
  body,
  ...(options.headers === undefined ? {} : { headers: options.headers }),
});
export const get = (
  as: string,
  queue: string,
  options: { noAck?: boolean; channel?: string } = {},
): LabStep => ({
  op: 'get',
  as,
  queue,
  noAck: options.noAck ?? false,
  channel: options.channel ?? MAIN,
});
/** Like `get`, but a broker refusal is recorded as the step's answer instead of aborting the run. */
export const tryGet = (
  as: string,
  queue: string,
  options: { noAck?: boolean; channel?: string } = {},
): LabStep => ({
  op: 'tryGet',
  as,
  queue,
  noAck: options.noAck ?? false,
  channel: options.channel ?? MAIN,
});
export const consume = (
  as: string,
  queue: string,
  count: number,
  options: { channel?: string; cancel?: boolean } = {},
): LabStep => ({
  op: 'consume',
  as,
  queue,
  count,
  channel: options.channel ?? MAIN,
  cancel: options.cancel ?? true,
});
/**
 * Waits until the broker has finished with what the scenario did to a queue: the ready count (a
 * passive declare, which the broker answers at once) has not changed for `stableFor` polls in a row.
 * It waits on broker state, not on a fixed time, and the record holds the count, never a duration.
 */
export const awaitReady = (
  queue: string,
  options: { stableFor?: number; timeoutMs?: number } = {},
): LabStep => ({
  op: 'awaitReady',
  queue,
  stableFor: options.stableFor ?? 5,
  timeoutMs: options.timeoutMs ?? 30_000,
});
/** Settles a delivery by its alias (`d1`, or `c.0` for the first delivery of consume `c`), or by a raw tag. */
export const settle = (
  target: string | number,
  action: SettleAction,
  options: { channel?: string; optional?: boolean } = {},
): LabStep => ({
  op: 'settle',
  target: typeof target === 'number' ? { tag: target } : { ref: target },
  channel: options.channel,
  action,
  ...(options.optional === true ? { optional: true } : {}),
});
export const recover = (channel = MAIN): LabStep => ({
  op: 'recover',
  channel,
});
export const mgmtGet = (
  as: string,
  queue: string,
  options: { count?: number; ackmode?: AckMode } = {},
): LabStep => ({
  op: 'mgmtGet',
  as,
  queue,
  count: options.count ?? 1,
  ackmode: options.ackmode ?? 'ack_requeue_true',
});
/** Drains the queue (acknowledgement off) and records, for every message published to it, what was found. */
export const observe = (
  name: string,
  queue: string,
  options: { channel?: string; from?: readonly string[] } = {},
): LabStep => ({
  op: 'observe',
  name,
  queue,
  channel: options.channel ?? MAIN,
  ...(options.from === undefined ? {} : { from: options.from }),
});

const ALIAS = /^[a-z][a-z0-9-]*$/;

/** Checks a scenario once, when it is written: a mistake is an error here, not a half-run on a broker. */
export function defineScenario(scenario: LabScenario): LabScenario {
  const fail = (index: number, message: string): never => {
    throw new Error(`${scenario.cfId} step ${String(index)}: ${message}`);
  };
  if (!CF_ID.test(scenario.cfId)) {
    throw new Error(`"${scenario.cfId}" is not a conformance id`);
  }
  if (scenario.steps.length === 0)
    throw new Error(`${scenario.cfId} has no steps`);
  const queues = new Set<string>();
  const exchanges = new Set<string>();
  const channels = new Set<string>([MAIN]);
  /** Connection name to whether it is still open; a name is never reused. */
  const connections = new Map<string, boolean>([[MAIN, true]]);
  const channelOn = new Map<string, string>([[MAIN, MAIN]]);
  const refs = new Set<string>();
  const published = new Set<string>();
  const addRef = (index: number, ref: string): void => {
    if (refs.has(ref)) fail(index, `the alias "${ref}" is used twice`);
    refs.add(ref);
  };
  scenario.steps.forEach((step, index) => {
    const needQueue = (queue: string): void => {
      if (!queues.has(queue))
        fail(index, `queue "${queue}" is not declared yet`);
    };
    // A settle may name a channel whose connection is gone (the broker's answer is the record).
    const needChannel = (channel: string, settling = false): void => {
      if (!channels.has(channel))
        fail(index, `channel "${channel}" is not open`);
      const on = channelOn.get(channel) ?? MAIN;
      if (!settling && connections.get(on) !== true) {
        fail(
          index,
          `channel "${channel}" is on connection "${on}", which is closed`,
        );
      }
    };
    const needTarget = (alias: string): void => {
      if (!queues.has(alias) && !exchanges.has(alias))
        fail(index, `"${alias}" is not a queue or exchange declared yet`);
    };
    switch (step.op) {
      case 'declareQueue':
        if (!ALIAS.test(step.queue))
          fail(index, `queue alias "${step.queue}" is not lower-case words`);
        if (
          step.exclusive === true &&
          (step.type !== 'classic' || step.durable)
        ) {
          fail(index, 'an exclusive queue is classic and not durable');
        }
        for (const value of Object.values(step.arguments)) {
          if (isRef(value)) needTarget(value.$ref);
        }
        queues.add(step.queue);
        break;
      case 'openConnection':
        if (!ALIAS.test(step.connection) || connections.has(step.connection)) {
          fail(
            index,
            `connection "${step.connection}" is invalid or already used`,
          );
        }
        connections.set(step.connection, true);
        break;
      case 'closeConnection':
        if (step.connection === MAIN)
          fail(index, 'the main connection is never closed by a scenario');
        if (connections.get(step.connection) !== true) {
          fail(index, `connection "${step.connection}" is not open`);
        }
        connections.set(step.connection, false);
        break;
      case 'declareExchange':
        if (!ALIAS.test(step.exchange) || exchanges.has(step.exchange))
          fail(
            index,
            `exchange "${step.exchange}" is invalid or already declared`,
          );
        exchanges.add(step.exchange);
        break;
      case 'bindQueue':
        needQueue(step.queue);
        if (!exchanges.has(step.exchange))
          fail(index, `exchange "${step.exchange}" is not declared yet`);
        if (isRef(step.key)) needTarget(step.key.$ref);
        else if (step.key === '' || step.key.length > 255)
          fail(index, 'a binding key is 1 to 255 characters');
        break;
      case 'wait':
        if (
          !Number.isInteger(step.ms) ||
          step.ms < 0 ||
          step.ms > MAX_WAIT_MS
        ) {
          fail(
            index,
            `a wait is a whole number of ms from 0 to ${String(MAX_WAIT_MS)}`,
          );
        }
        break;
      case 'mgmtQueue':
        needQueue(step.queue);
        if (!ALIAS.test(step.as))
          fail(index, `alias "${step.as}" is not lower-case words`);
        addRef(index, step.as);
        break;
      case 'openChannel':
        if (!ALIAS.test(step.channel) || channels.has(step.channel)) {
          fail(index, `channel "${step.channel}" is invalid or already open`);
        }
        if (connections.get(step.connection) !== true) {
          fail(index, `connection "${step.connection}" is not open`);
        }
        channels.add(step.channel);
        channelOn.set(step.channel, step.connection);
        break;
      case 'closeChannel':
        needChannel(step.channel);
        break;
      case 'awaitReady':
        needQueue(step.queue);
        if (!Number.isInteger(step.stableFor) || step.stableFor < 1) {
          fail(index, 'an awaitReady needs a stableFor of at least 1');
        }
        if (!Number.isInteger(step.timeoutMs) || step.timeoutMs < 1) {
          fail(index, 'an awaitReady needs a timeout of at least 1 ms');
        }
        break;
      case 'publish':
        needQueue(step.queue);
        if (published.has(step.messageId))
          fail(index, `message id "${step.messageId}" is used twice`);
        published.add(step.messageId);
        if (step.headers !== undefined) {
          const entries = Object.entries(step.headers);
          if (
            entries.some(
              ([name, value]) =>
                name !== 'x-delivery-count' ||
                !Number.isInteger(value) ||
                (value as number) < 0,
            )
          ) {
            fail(
              index,
              'the only header a publish may set is x-delivery-count, as a whole number',
            );
          }
        }
        break;
      case 'get':
      case 'tryGet':
        needQueue(step.queue);
        needChannel(step.channel);
        if (!ALIAS.test(step.as))
          fail(index, `alias "${step.as}" is not lower-case words`);
        addRef(index, step.as);
        break;
      case 'consume':
        needQueue(step.queue);
        needChannel(step.channel);
        if (!ALIAS.test(step.as) || step.count < 1)
          fail(index, 'a consume needs an alias and a count of at least 1');
        for (let n = 0; n < step.count; n += 1)
          addRef(index, `${step.as}.${String(n)}`);
        break;
      case 'settle':
        if ('ref' in step.target && !refs.has(step.target.ref)) {
          fail(
            index,
            `"${step.target.ref}" was not delivered by an earlier step`,
          );
        }
        if (step.channel !== undefined) needChannel(step.channel, true);
        break;
      case 'recover':
        needChannel(step.channel);
        break;
      case 'mgmtGet':
        needQueue(step.queue);
        if (!ALIAS.test(step.as) || step.count < 1)
          fail(index, 'a mgmtGet needs an alias and a count of at least 1');
        addRef(index, step.as);
        break;
      case 'observe':
        needQueue(step.queue);
        needChannel(step.channel);
        for (const source of step.from ?? []) {
          if (!queues.has(source))
            fail(
              index,
              `observe names "${source}", which is not a declared queue`,
            );
        }
        break;
    }
  });
  return scenario;
}

/** What a scenario needs from a broker; `Amqp091Raw` plus `httpRaw` provide it. */
export interface ScenarioHost {
  /** Opens a connection of its own, beside the default `main`; the broker sees a second client. */
  openConnection(name: string): Promise<void>;
  /** Graceful `connection.close`; the channels on it go with it. */
  closeConnection(name: string): Promise<void>;
  openChannel(name: string, connection?: string): Promise<void>;
  closeChannel(name: string): Promise<void>;
  /** Messages ready in the queue, from a passive declare. */
  readyCount(queue: string): Promise<number>;
  declareQueue(
    queue: string,
    options: {
      type: QueueType;
      durable: boolean;
      /** Present only for an exclusive queue (owned by `main`). */
      exclusive?: boolean;
      arguments: Readonly<Record<string, unknown>>;
    },
  ): Promise<void>;
  deleteQueue(queue: string): Promise<void>;
  declareExchange(exchange: string, kind: 'direct' | 'fanout'): Promise<void>;
  deleteExchange(exchange: string): Promise<void>;
  bindQueue(queue: string, exchange: string, key: string): Promise<void>;
  publish(
    queue: string,
    message: { messageId: string; body: Buffer; headers?: CopiedHeaders },
  ): Promise<void>;
  get(
    channel: string,
    queue: string,
    noAck: boolean,
  ): Promise<RawDelivery | null>;
  /** `get` that reports a reply the broker closed the channel or connection with, instead of throwing. */
  tryGet(
    channel: string,
    queue: string,
    noAck: boolean,
  ): Promise<Attempt<RawDelivery | null>>;
  consume(
    channel: string,
    queue: string,
    count: number,
    cancel?: boolean,
  ): Promise<RawDelivery[]>;
  settle(
    channel: string,
    tag: number,
    action: SettleAction,
  ): Promise<SettleOutcome>;
  recover(channel: string): Promise<void>;
  management(call: {
    method: 'GET' | 'PUT' | 'POST' | 'DELETE';
    path: string;
    body?: unknown;
  }): Promise<HttpRawResponse>;
}

export interface ScenarioRun {
  readonly steps: EvidenceStep[];
  readonly observations: EvidenceObservation[];
}

interface Held {
  readonly tag: number;
  readonly channel: string;
}

const deliveryJson = (delivery: RawDelivery): Record<string, Json> => ({
  messageId: delivery.messageId,
  deliveryTag: delivery.tag,
  redelivered: delivery.redelivered,
  messageCount: delivery.messageCount,
  'x-delivery-count': delivery.xDeliveryCount,
  'x-acquired-count': delivery.xAcquiredCount,
});

/** Time as a run sees it, so a test needs no real waiting and no real clock. */
export interface RunClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const REAL_CLOCK: RunClock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;

/**
 * The class of a clock value the broker reported (`next_delayed_at`): never the value itself, so a
 * live replay can equal the evidence. A number is read as epoch milliseconds, a string as a date.
 */
export function clockClass(
  value: unknown,
  now: number,
): 'absent' | 'future' | 'past' | 'unparsed' {
  if (value === undefined || value === null) return 'absent';
  const at =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Date.parse(value)
        : Number.NaN;
  if (!Number.isFinite(at)) return 'unparsed';
  return at > now ? 'future' : 'past';
}

/** A reply name as the broker spells it (`RESOURCE_LOCKED`); anything else is recorded as `unparsed`. */
const REPLY_NAME = /^[A-Z][A-Z_]*$/;

/** The most a single observe drains: a queue that holds more is an error, not a partial record. */
export const DRAIN_LIMIT = 200;

/** The gap between two polls of `awaitReady`; it paces the polls and is never recorded. */
export const AWAIT_POLL_MS = 50;

/**
 * Polls until the count has been the same `stableFor` times in a row and returns it. The loop is
 * bounded by `timeoutMs`; an unsettled queue is an error naming it, so a run never hangs and never
 * records a count the broker was still changing.
 */
async function untilStable(
  poll: () => Promise<number>,
  step: Extract<LabStep, { op: 'awaitReady' }>,
): Promise<number> {
  const deadline = Date.now() + step.timeoutMs;
  let last = -1;
  let same = 0;
  for (;;) {
    const count = await poll();
    same = count === last ? same + 1 : 1;
    last = count;
    if (same >= step.stableFor) return count;
    if (Date.now() >= deadline) {
      throw new Error(
        `queue "${step.queue}" did not hold a steady ready count within the time allowed (last count ${String(count)})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, AWAIT_POLL_MS));
  }
}

/**
 * Runs the steps in order against the host. Queues are created under a name that carries `runId`
 * (so two runs never meet) and deleted at the end, whatever happened; the records use the aliases.
 */
export async function runScenario(
  host: ScenarioHost,
  scenario: LabScenario,
  runId: string,
  drainLimit = DRAIN_LIMIT,
  clock: RunClock = REAL_CLOCK,
): Promise<ScenarioRun> {
  const physical = (queue: string): string =>
    `lab-${scenario.cfId.toLowerCase()}-${runId}-${queue}`;
  const steps: EvidenceStep[] = [];
  const observations: EvidenceObservation[] = [];
  const held = new Map<string, Held>();
  const declared: string[] = [];
  const declaredExchanges: string[] = [];
  const resolve = (value: Json | Ref): Json =>
    isRef(value) ? physical(value.$ref) : value;
  const publishedTo = new Map<string, string[]>();

  const run = async (
    step: LabStep,
  ): Promise<{ args: Record<string, Json>; result: Record<string, Json> }> => {
    switch (step.op) {
      case 'declareQueue':
        await host.declareQueue(physical(step.queue), {
          ...step,
          arguments: Object.fromEntries(
            Object.entries(step.arguments).map(([name, value]) => [
              name,
              resolve(value),
            ]),
          ),
        });
        declared.push(step.queue);
        return {
          args: {
            queue: step.queue,
            type: step.type,
            durable: step.durable,
            ...(step.exclusive === true ? { exclusive: true } : {}),
            arguments: Object.fromEntries(
              Object.entries(step.arguments).map(([name, value]) => [
                name,
                plain(value),
              ]),
            ),
          },
          result: { ok: true },
        };
      case 'openConnection':
        await host.openConnection(step.connection);
        return {
          args: { connection: step.connection },
          result: { ok: true },
        };
      case 'closeConnection':
        await host.closeConnection(step.connection);
        return {
          args: { connection: step.connection },
          result: { ok: true },
        };
      case 'declareExchange':
        await host.declareExchange(physical(step.exchange), step.kind);
        declaredExchanges.push(step.exchange);
        return {
          args: { exchange: step.exchange, kind: step.kind },
          result: { ok: true },
        };
      case 'bindQueue':
        await host.bindQueue(
          physical(step.queue),
          physical(step.exchange),
          isRef(step.key) ? physical(step.key.$ref) : step.key,
        );
        return {
          args: {
            queue: step.queue,
            exchange: step.exchange,
            key: plain(step.key),
          },
          result: { ok: true },
        };
      case 'wait':
        await clock.sleep(step.ms);
        return { args: { ms: step.ms }, result: { ok: true } };
      case 'mgmtQueue': {
        const response = await host.management({
          method: 'GET',
          path: `/api/queues/%2F/${encodeURIComponent(physical(step.queue))}`,
        });
        const stats =
          typeof response.json === 'object' && response.json !== null
            ? (response.json as Record<string, unknown>)
            : {};
        return {
          args: { as: step.as, queue: step.queue },
          result: {
            status: response.status,
            messagesReady: count(stats.messages_ready),
            messagesUnacknowledged: count(stats.messages_unacknowledged),
            messagesDelayed: count(stats.messages_delayed),
            nextDelayedAt: clockClass(stats.next_delayed_at, clock.now()),
          },
        };
      }
      case 'openChannel':
        await host.openChannel(step.channel, step.connection);
        // The default connection is not recorded, so a scenario without a second one records as before.
        return {
          args:
            step.connection === MAIN
              ? { channel: step.channel }
              : { channel: step.channel, connection: step.connection },
          result: { ok: true },
        };
      case 'closeChannel':
        await host.closeChannel(step.channel);
        return { args: { channel: step.channel }, result: { ok: true } };
      case 'awaitReady': {
        const ready = await untilStable(
          () => host.readyCount(physical(step.queue)),
          step,
        );
        return {
          args: { queue: step.queue, stableFor: step.stableFor },
          result: { ready },
        };
      }
      case 'publish': {
        const body = Buffer.from(step.body);
        await host.publish(physical(step.queue), {
          messageId: step.messageId,
          body,
          ...(step.headers === undefined ? {} : { headers: step.headers }),
        });
        publishedTo.set(step.queue, [
          ...(publishedTo.get(step.queue) ?? []),
          step.messageId,
        ]);
        return {
          args: {
            queue: step.queue,
            messageId: step.messageId,
            bytes: body.length,
            ...(step.headers === undefined
              ? {}
              : { headers: Object.fromEntries(Object.entries(step.headers)) }),
          },
          result: { confirmed: true },
        };
      }
      case 'get': {
        const delivery = await host.get(
          step.channel,
          physical(step.queue),
          step.noAck,
        );
        if (delivery !== null) {
          held.set(step.as, { tag: delivery.tag, channel: step.channel });
        }
        return {
          args: {
            as: step.as,
            queue: step.queue,
            noAck: step.noAck,
            channel: step.channel,
          },
          result:
            delivery === null
              ? { empty: true }
              : { empty: false, ...deliveryJson(delivery) },
        };
      }
      case 'tryGet': {
        const attempt = await host.tryGet(
          step.channel,
          physical(step.queue),
          step.noAck,
        );
        const args = {
          as: step.as,
          queue: step.queue,
          noAck: step.noAck,
          channel: step.channel,
        };
        if (attempt.refused) {
          // Three fields, each checked: nothing else the host passed can reach the record.
          const { level, code, reply } = attempt.refusal;
          return {
            args,
            result: {
              outcome: 'refused',
              level: level === 'connection' ? 'connection' : 'channel',
              code: count(code),
              reply: REPLY_NAME.test(reply) ? reply : 'unparsed',
            },
          };
        }
        const delivery = attempt.value;
        if (delivery === null) return { args, result: { outcome: 'empty' } };
        held.set(step.as, { tag: delivery.tag, channel: step.channel });
        return {
          args,
          result: { outcome: 'delivery', ...deliveryJson(delivery) },
        };
      }
      case 'consume': {
        const deliveries = await host.consume(
          step.channel,
          physical(step.queue),
          step.count,
          step.cancel,
        );
        deliveries.forEach((delivery, n) => {
          held.set(`${step.as}.${String(n)}`, {
            tag: delivery.tag,
            channel: step.channel,
          });
        });
        return {
          args: {
            as: step.as,
            queue: step.queue,
            count: step.count,
            channel: step.channel,
            // Only a consumer left active is recorded, so the existing records stay as they were.
            ...(step.cancel ? {} : { cancel: false }),
          },
          result: {
            deliveries: deliveries.map((delivery, n) => ({
              ref: `${step.as}.${String(n)}`,
              ...deliveryJson(delivery),
            })),
          },
        };
      }
      case 'settle': {
        const source =
          'ref' in step.target ? held.get(step.target.ref) : undefined;
        if ('ref' in step.target && source === undefined) {
          // Only a scenario that asks for it (a poll that may find nothing) tolerates an absent delivery.
          if (step.optional === true) {
            return {
              args: { target: step.target.ref, optional: true },
              result: { skipped: true },
            };
          }
          throw new Error(
            `"${step.target.ref}" was not delivered (nothing came back from the broker)`,
          );
        }
        const tag =
          'tag' in step.target ? step.target.tag : (source?.tag ?? -1);
        const channel = step.channel ?? source?.channel ?? MAIN;
        const outcome = await host.settle(channel, tag, step.action);
        return {
          args: {
            target: 'ref' in step.target ? step.target.ref : null,
            deliveryTag: tag,
            channel,
            action: step.action.kind,
            requeue: 'requeue' in step.action ? step.action.requeue : null,
            multiple:
              'multiple' in step.action
                ? (step.action.multiple ?? false)
                : null,
          },
          result: {
            channelOpen: outcome.channelOpen,
            closed: outcome.channelOpen
              ? null
              : { code: outcome.closed.code, text: outcome.closed.text },
          },
        };
      }
      case 'recover':
        await host.recover(step.channel);
        return { args: { channel: step.channel }, result: { ok: true } };
      case 'mgmtGet': {
        const response = await host.management({
          method: 'POST',
          path: `/api/queues/%2F/${encodeURIComponent(physical(step.queue))}/get`,
          body: { count: step.count, ackmode: step.ackmode, encoding: 'auto' },
        });
        const messages = Array.isArray(response.json)
          ? (response.json as unknown[])
          : [];
        return {
          args: {
            as: step.as,
            queue: step.queue,
            count: step.count,
            ackmode: step.ackmode,
          },
          result: {
            status: response.status,
            messages: messages.map((message): Json => {
              const record = message as {
                redelivered?: unknown;
                payload_bytes?: unknown;
                message_count?: unknown;
                properties?: { message_id?: unknown };
              };
              return {
                messageId:
                  typeof record.properties?.message_id === 'string'
                    ? record.properties.message_id
                    : null,
                redelivered: record.redelivered === true,
                payloadBytes:
                  typeof record.payload_bytes === 'number'
                    ? record.payload_bytes
                    : null,
                messageCount:
                  typeof record.message_count === 'number'
                    ? record.message_count
                    : null,
              };
            }),
          },
        };
      }
      case 'observe': {
        const expected = (step.from ?? [step.queue]).flatMap(
          (source) => publishedTo.get(source) ?? [],
        );
        const found = new Map<string, EvidenceObservation>();
        for (let position = 0; ; position += 1) {
          const delivery = await host.get(
            step.channel,
            physical(step.queue),
            true,
          );
          if (delivery === null) break;
          if (position >= drainLimit) {
            throw new Error(
              `the queue holds more than ${String(drainLimit)} messages`,
            );
          }
          const id = delivery.messageId;
          if (id === null || !expected.includes(id) || found.has(id)) {
            throw new Error(
              `the queue held a message this scenario did not publish (id ${JSON.stringify(id)})`,
            );
          }
          found.set(id, {
            name: step.name,
            messageId: id,
            survived: true,
            position,
            redelivered: delivery.redelivered,
            'x-delivery-count': delivery.xDeliveryCount,
            'x-acquired-count': delivery.xAcquiredCount,
          });
        }
        for (const id of expected) {
          observations.push(
            found.get(id) ?? {
              name: step.name,
              messageId: id,
              survived: false,
              position: null,
              redelivered: null,
              'x-delivery-count': null,
              'x-acquired-count': null,
            },
          );
        }
        return {
          args: {
            name: step.name,
            queue: step.queue,
            channel: step.channel,
            ...(step.from === undefined ? {} : { from: [...step.from] }),
          },
          result: { drained: found.size, published: expected.length },
        };
      }
    }
  };

  try {
    for (const [index, step] of scenario.steps.entries()) {
      const { args, result } = await run(step);
      steps.push({ index, op: step.op, args, result });
    }
  } finally {
    for (const queue of declared) {
      await host.deleteQueue(physical(queue)).catch(() => undefined);
    }
    for (const exchange of declaredExchanges) {
      await host.deleteExchange(physical(exchange)).catch(() => undefined);
    }
  }
  return { steps, observations };
}
