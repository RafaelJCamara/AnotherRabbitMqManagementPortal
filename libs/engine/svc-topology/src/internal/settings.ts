// What a queue or an exchange really has, resolved before the routing library sees it (spec R2):
// argument over policy through the effective-config resolver, the delivery limit from the queue stat,
// and "unknown" wherever a policy that decides could not be read. Nothing here guesses: a layer that
// cannot be decided makes the answer `unknown`, never a default.
import {
  matchPolicy,
  resolveEffective,
  type EffectiveConfig,
  type PolicyDefinition,
  type PolicyInput,
  type PolicyTarget,
  type PolicyValue,
} from '@app/effective-config';
import {
  QueueTypeSchema,
  type QueueType,
  type SemVer,
} from '@app/domain-model';
import type {
  DeadLetterSetting,
  TopologyExchange,
  TopologyQueue,
} from '@app/routing';
import type { DeliveryLimit } from '@app/semantics';

import type { ExchangeRow, PolicyRow, QueueRow } from './rows';
import type { PolicyList } from './snapshot';

/** The policy keys an answer reports even when nothing sets them. */
const REPORTED_KEYS = [
  'dead-letter-exchange',
  'dead-letter-routing-key',
  'expires',
  'max-length',
  'max-length-bytes',
  'message-ttl',
  'overflow',
] as const;
const REPORTED_QUORUM_KEYS = [
  'dead-letter-strategy',
  'delivery-limit',
] as const;

/** Why a policy layer could not be decided. */
export type UnknownWhy = 'unreadable' | 'not-listed' | 'ambiguous';

/** One policy layer of a queue: the user policy or the operator policy. */
export type PolicyLayer =
  | { readonly state: 'none' }
  | { readonly state: 'policy'; readonly policy: PolicyInput }
  | { readonly state: 'unknown'; readonly why: UnknownWhy };

const definitionOf = (row: PolicyRow): PolicyDefinition => ({
  name: row.name,
  pattern: row.pattern,
  applyTo: row['apply-to'],
  priority: row.priority,
  definition: row.definition,
});

const inputOf = (policy: PolicyDefinition): PolicyInput => ({
  name: policy.name,
  definition: policy.definition,
});

/**
 * The layer a queue (or exchange) has. `stat` is what the broker said on the object itself: a name,
 * `null` for "no policy", or `undefined` when it did not send the field (statistics off below 4.2.5).
 */
export function layerOf(
  stat: string | null | undefined,
  list: PolicyList,
  target: PolicyTarget,
): PolicyLayer {
  if (list.state === 'unreadable')
    return { state: 'unknown', why: 'unreadable' };
  const policies = list.policies.map(definitionOf);
  if (typeof stat === 'string') {
    const named = policies.find((policy) => policy.name === stat);
    return named === undefined
      ? { state: 'unknown', why: 'not-listed' }
      : { state: 'policy', policy: inputOf(named) };
  }
  if (stat === null) return { state: 'none' };
  const match = matchPolicy(policies, target);
  if (match.kind === 'none') return { state: 'none' };
  if (match.kind === 'one') {
    return { state: 'policy', policy: inputOf(match.policy) };
  }
  return { state: 'unknown', why: 'ambiguous' };
}

export interface QueueConfig {
  /** The queue type the row names; null when it names none the registry knows. */
  readonly type: QueueType | null;
  readonly layers: {
    readonly user: PolicyLayer;
    readonly operator: PolicyLayer;
  };
  /** Null when the type or a policy layer is unknown: nothing is resolved from a guess. */
  readonly effective: EffectiveConfig | null;
  /** The broker did not send `policy`, `operator_policy`, or a quorum queue's `delivery_limit`. */
  readonly statsMissing: boolean;
  /** A policy match that `matchPolicy` cannot decide (a tie, or a pattern it cannot evaluate). */
  readonly undecided: boolean;
}

export interface SettingsInput {
  readonly policies: PolicyList;
  readonly operatorPolicies: PolicyList;
  /** The lowest node version of the cluster; null when unreadable (OQ-971). */
  readonly version: SemVer | null;
}

export function resolveQueueConfig(
  row: QueueRow,
  input: SettingsInput,
): QueueConfig {
  const parsed = QueueTypeSchema.safeParse(row.type);
  const type = parsed.success ? parsed.data : null;
  const target: PolicyTarget = {
    kind: 'queue',
    name: row.name,
    queueType: type ?? 'classic',
  };
  const user = layerOf(row.policy, input.policies, target);
  const operator = layerOf(row.operator_policy, input.operatorPolicies, target);
  const statsMissing =
    row.policy === undefined ||
    row.operator_policy === undefined ||
    (type === 'quorum' && row.delivery_limit === undefined);
  const undecided = [user, operator].some(
    (layer) => layer.state === 'unknown' && layer.why === 'ambiguous',
  );
  const effective =
    type === null || user.state === 'unknown' || operator.state === 'unknown'
      ? null
      : resolveEffective({
          queueType: type,
          version: input.version,
          args: row.arguments ?? {},
          userPolicy: user.state === 'policy' ? user.policy : null,
          operatorPolicy: operator.state === 'policy' ? operator.policy : null,
          keys:
            type === 'quorum'
              ? [...REPORTED_KEYS, ...REPORTED_QUORUM_KEYS]
              : [...REPORTED_KEYS],
        });
  return {
    type,
    layers: { user, operator },
    effective,
    statsMissing,
    undecided,
  };
}

/** The value of an `effective` or `default` entry; undefined when nothing (or "no limit") is set. */
function valueOf(
  effective: EffectiveConfig,
  key: string,
): PolicyValue | undefined {
  const entry = effective.entries[key];
  if (entry === undefined) return undefined;
  return (entry.status === 'effective' || entry.status === 'default') &&
    entry.value !== null
    ? entry.value
    : undefined;
}

const finiteCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

/**
 * A limit: from the resolver when it ran; otherwise from the argument alone, because a policy that
 * could not be read can only make the limit smaller, never remove it.
 */
function limitOf(
  config: QueueConfig,
  args: Readonly<Record<string, unknown>>,
  key: string,
  argument: string,
): number | undefined {
  return config.effective === null
    ? finiteCount(args[argument])
    : finiteCount(valueOf(config.effective, key));
}

const OVERFLOWS = [
  'drop-head',
  'reject-publish',
  'reject-publish-dlx',
] as const;
const STRATEGIES = ['at-most-once', 'at-least-once'] as const;

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return allowed.find((item) => item === value);
}

const UNKNOWN_SETTING: DeadLetterSetting = { status: 'unknown' };

/** The dead-letter setting: `undefined` is "none", the message is dropped where it dies. */
function deadLetterOf(
  config: QueueConfig,
  args: Readonly<Record<string, unknown>>,
): DeadLetterSetting | undefined {
  const effective = config.effective;
  if (effective === null) {
    // A layer is unknown: only an argument, which beats every policy, can still decide the exchange.
    const exchange = args['x-dead-letter-exchange'];
    if (typeof exchange !== 'string') return UNKNOWN_SETTING;
    // The routing key and strategy could come from the unread policy: only an argument decides them.
    const key = args['x-dead-letter-routing-key'];
    if (typeof key !== 'string') return UNKNOWN_SETTING;
    const strategy = oneOf(args['x-dead-letter-strategy'], STRATEGIES);
    return {
      status: 'set',
      exchange,
      routingKey: key,
      ...(strategy === undefined ? {} : { strategy }),
    };
  }
  const entry = effective.entries['dead-letter-exchange'];
  if (entry === undefined || entry.status === 'unset') return undefined;
  if (entry.status === 'default' && entry.value === null) return undefined;
  if (entry.status !== 'effective' && entry.status !== 'default') {
    return UNKNOWN_SETTING;
  }
  if (typeof entry.value !== 'string') return UNKNOWN_SETTING;
  const key = valueOf(effective, 'dead-letter-routing-key');
  const strategy = oneOf(
    valueOf(effective, 'dead-letter-strategy'),
    STRATEGIES,
  );
  return {
    status: 'set',
    exchange: entry.value,
    ...(typeof key === 'string' ? { routingKey: key } : {}),
    ...(strategy === undefined ? {} : { strategy }),
  };
}

const UNKNOWN_LIMIT: DeliveryLimit = { kind: 'unknown' };

function limitFrom(value: number): DeliveryLimit {
  if (!Number.isFinite(value)) return UNKNOWN_LIMIT;
  return value < 0 ? { kind: 'unlimited' } : { kind: 'finite', value };
}

/**
 * The delivery limit of a quorum queue: the broker's own figure from the queue stat when it sent a
 * number, otherwise the resolver's. A classic or stream queue gets none (unknown, never unlimited,
 * until U-01(4) is answered by the lab; OQ-1406).
 */
function deliveryLimitOf(
  row: QueueRow,
  config: QueueConfig,
): DeliveryLimit | undefined {
  if (config.type !== 'quorum') return undefined;
  if (typeof row.delivery_limit === 'number')
    return limitFrom(row.delivery_limit);
  if (typeof row.delivery_limit === 'string') return UNKNOWN_LIMIT;
  const entry = config.effective?.entries['delivery-limit'];
  if (entry === undefined) return UNKNOWN_LIMIT;
  if (entry.status === 'effective' || entry.status === 'default') {
    if (typeof entry.value === 'number') return limitFrom(entry.value);
    if (entry.value === null && entry.status === 'default') {
      return { kind: 'unlimited' };
    }
  }
  return UNKNOWN_LIMIT;
}

/** The queue as the routing library takes it (R2). `acking`: names of queues whose consumers acknowledge. */
export function toTopologyQueue(
  row: QueueRow,
  config: QueueConfig,
  acking: ReadonlySet<string>,
): TopologyQueue {
  const args = row.arguments ?? {};
  const deadLetter = deadLetterOf(config, args);
  const ttl = limitOf(config, args, 'message-ttl', 'x-message-ttl');
  const length = limitOf(config, args, 'max-length', 'x-max-length');
  const bytes = limitOf(config, args, 'max-length-bytes', 'x-max-length-bytes');
  const overflow = oneOf(
    config.effective === null
      ? args['x-overflow']
      : valueOf(config.effective, 'overflow'),
    OVERFLOWS,
  );
  const deliveryLimit = deliveryLimitOf(row, config);
  return {
    name: row.name,
    ...(config.type === null ? {} : { type: config.type }),
    ...(deadLetter === undefined ? {} : { deadLetter }),
    ...(ttl === undefined ? {} : { messageTtlMs: ttl }),
    ...(length === undefined ? {} : { maxLength: length }),
    ...(bytes === undefined ? {} : { maxLengthBytes: bytes }),
    ...(overflow === undefined ? {} : { overflow }),
    ...(deliveryLimit === undefined ? {} : { deliveryLimit }),
    ...(acking.has(row.name) ? { rejectable: true } : {}),
  };
}

/**
 * The alternate exchange of an exchange: the argument, else the matching user policy (OQ-1410).
 * `value` is `undefined` when it cannot be told (policies unreadable, or a match that is undecided).
 */
export function alternateExchangeOf(
  row: ExchangeRow,
  policies: PolicyList,
): { readonly value: string | null | undefined; readonly undecided: boolean } {
  const argument = row.arguments?.['alternate-exchange'];
  if (typeof argument === 'string')
    return { value: argument, undecided: false };
  if (policies.state === 'unreadable') {
    return { value: undefined, undecided: false };
  }
  const match = matchPolicy(policies.policies.map(definitionOf), {
    kind: 'exchange',
    name: row.name,
  });
  if (match.kind === 'none') return { value: null, undecided: false };
  if (match.kind === 'ambiguous') return { value: undefined, undecided: true };
  const ae = match.policy.definition['alternate-exchange'];
  return { value: typeof ae === 'string' ? ae : null, undecided: false };
}

export function toTopologyExchange(
  row: ExchangeRow,
  policies: PolicyList,
): { readonly exchange: TopologyExchange; readonly undecided: boolean } {
  const ae = alternateExchangeOf(row, policies);
  return {
    exchange: {
      name: row.name,
      type: row.type,
      ...(row.internal === true ? { internal: true } : {}),
      ...(ae.value === undefined ? {} : { alternateExchange: ae.value }),
    },
    undecided: ae.undecided,
  };
}
