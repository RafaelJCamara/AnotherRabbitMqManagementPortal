// The rescue preflight (M1-13 slice C, DC-09, blueprint 5.5 steps 1 to 5, amendment A-5): judges what
// the peek preflight read about the quarantine path and answers the planner's `RescueFacts`, before
// any message is acquired. Pure: it asks the semantics registry (I-3, the era is data), reads nothing
// itself and names no write port or lease (I-2). Everything it cannot decide fails closed (I-13), and
// the result holds numbers, names and closed codes, never a body or the broker's text (I-10).
//
// What it judges: the shape of the queue (an existing one is reused only when it is the spec), whether
// classic queues exist here, what policies would do to a queue of that name (a limit, a TTL, an
// expiry, an overflow other than reject-publish), the headroom left, the user's permissions, node
// alarms and whether one of our connections is blocked.
import {
  resolveHypothetical,
  testPattern,
  type PolicyDefinition,
} from '@app/effective-config';
import type { Era } from '@app/domain-model';
import type { RescueFacts } from '@app/peek-planner';
import {
  SemanticsGapError,
  semanticsRegistry,
  type BrokerSemanticsRegistry,
} from '@app/semantics';

import type { PolicyRow } from './preflight-rows.ts';
import type { PreflightProfile, Read, RescueReads } from './preflight.ts';
import {
  buildQuarantineSpec,
  conformsToSpec,
  type QuarantineQueueSpec,
} from './quarantine.ts';

/** Every reason the rescue preflight can give. Closed on purpose: the receipt and the UI key on it. */
export const RESCUE_FAILURES = [
  'queue-wrong-shape',
  'queue-unreadable',
  'classic-disabled-no-fallback',
  'headroom',
  'overflow',
  'message-ttl',
  'expires',
  'policies-unreadable',
  'policy-undecided',
  'permission-configure',
  'permission-write',
  'permission-undecided',
  'alarm',
  'alarm-unreadable',
  'publish-blocked',
] as const;
export type RescueFailure = (typeof RESCUE_FAILURES)[number];

/** The failures that make `overflowSafe` false: what policies and headroom do to the quarantine. */
const SETTING_FAILURES: ReadonlySet<RescueFailure> = new Set([
  'headroom',
  'overflow',
  'message-ttl',
  'expires',
  'policies-unreadable',
  'policy-undecided',
]);
const PERMISSION_FAILURES: ReadonlySet<RescueFailure> = new Set([
  'permission-configure',
  'permission-write',
  'permission-undecided',
]);

/** The policy keys that decide how a queue of the quarantine's name behaves. */
const SETTING_KEYS = [
  'overflow',
  'max-length',
  'max-length-bytes',
  'message-ttl',
  'expires',
] as const;

/** The largest default byte cap of the peek table (OQ-1472): room for one message of that size. */
export const RESCUE_BYTES_FLOOR = 16 * 1024 * 1024;
/** Alarm codes listed in the facts; the rest are counted in `checks.alarmsOmitted` (I-6). */
export const MAX_ALARMS = 32;
/** The doomed message is the first one met and acquisition stops there (OQ-1472). */
const NEED_MESSAGES = 1;
const NAME_MAX = 128;
/**
 * The names a publish to the default exchange may be checked against (OQ-1476, not confirmed): the
 * `write` pattern has to allow both.
 */
const DEFAULT_EXCHANGE_NAMES = ['', 'amq.default'] as const;

export type CheckState = 'read' | 'unreadable';

export interface RescuePreflightResult {
  /** What the planner reads. */
  readonly facts: RescueFacts;
  readonly queue: {
    /** `will-create` is ready: the arm step declares it once, from `execute()` (OQ-1467). */
    readonly state: 'exists' | 'will-create' | 'unavailable';
    readonly declaredType: 'classic' | 'quorum-unlimited';
    /** True when the profile did not say whether classic queues are enabled (OQ-1469). */
    readonly classicAssumed: boolean;
  };
  /** What the arm step declares; null when the queue exists or is unavailable. */
  readonly declare: QuarantineQueueSpec | null;
  /** The policies that would apply to a queue of this name, by name. */
  readonly policyMatches: {
    readonly user: readonly string[];
    readonly operator: readonly string[];
  };
  /**
   * Room left under the effective limits; null when no limit is effective or the policies could not
   * be decided (see `failures`). An unread count of a limited queue is zero room (fail closed).
   */
  readonly headroom: {
    readonly messages: number | null;
    readonly bytes: number | null;
    readonly needMessages: number;
    readonly needBytes: number;
  };
  /** Which reads succeeded; an unreadable list is reported and never read as "nothing there". */
  readonly checks: {
    readonly quarantine: CheckState;
    readonly policies: CheckState;
    readonly operatorPolicies: CheckState;
    readonly nodes: CheckState;
    readonly connections: CheckState;
    readonly permission: CheckState;
    readonly alarmsOmitted: number;
  };
  /** Closed codes only, in the order of `RESCUE_FAILURES`. */
  readonly failures: readonly RescueFailure[];
}

export interface RescueJudgement {
  readonly vhost: string;
  readonly queueName: string;
  readonly profile: PreflightProfile;
  readonly reads: RescueReads;
  /** The clock reading after the last read. */
  readonly checkedAt: number;
}

export interface RescuePreflight {
  judge(input: RescueJudgement): RescuePreflightResult;
}

/** The registry lookups the rescue preflight uses (I-3: it asks, it compares no version). */
export type RescueRegistry = Pick<
  BrokerSemanticsRegistry,
  'cell' | 'effectiveConfig'
>;

export interface RescuePreflightDeps {
  readonly registry?: RescueRegistry;
  /** The prefix of our connection names (`${prefix}/...`), the one the quarantine name uses. */
  readonly connectionPrefix: string;
}

/**
 * Whether a quorum queue with limit `-1` keeps a returned message on this era. The registry cell for
 * a return with `minus1` must exist and must not destroy the message (3.13 drops or dead-letters it).
 * The tail (4.0 to 4.2) is fine here: nothing consumes the quarantine in a peek. A missing cell or a
 * cell without an effect is not safe.
 */
function fallbackKeepsMessages(registry: RescueRegistry, era: Era): boolean {
  for (const delayedRetry of ['disabled', undefined] as const) {
    try {
      const cell = registry.cell({
        era,
        queueType: 'quorum',
        protocol: 'amqp091',
        action: 'amqp091.nack_requeue',
        limit: 'minus1',
        ...(delayedRetry === undefined ? {} : { delayedRetry }),
      });
      return cell.effect !== null && !cell.effect.destructive;
    } catch (error) {
      if (!(error instanceof SemanticsGapError)) throw error;
    }
  }
  return false;
}

const checkOf = <T>(read: Read<T>): CheckState => read.state;

const asDefinition = (row: PolicyRow): PolicyDefinition => ({
  name: row.name,
  pattern: row.pattern,
  applyTo: row['apply-to'],
  priority: row.priority,
  definition: row.definition,
});

export function createRescuePreflight(
  deps: RescuePreflightDeps,
): RescuePreflight {
  const registry: RescueRegistry = deps.registry ?? semanticsRegistry;
  const ours = `${deps.connectionPrefix}/`;

  return {
    judge({ vhost, queueName, profile, reads, checkedAt }) {
      const failures = new Set<RescueFailure>();

      // 1. The queue: reuse a conforming one, declare it once when absent, never touch another shape.
      const classicSpec = buildQuarantineSpec(queueName, vhost, 'classic');
      const quorumSpec = buildQuarantineSpec(queueName, vhost, 'quorum');
      const fallback = fallbackKeepsMessages(registry, profile.era.value);
      const unknownClassic = profile.classicEnabled === 'unknown';
      let queueState: 'exists' | 'will-create' | 'unavailable' = 'unavailable';
      let spec: QuarantineQueueSpec | null = null;
      const found = reads.quarantine;
      if (found.state === 'unreadable') {
        failures.add('queue-unreadable');
      } else if (found.state === 'present') {
        if (conformsToSpec(found.found, classicSpec) === 'conforms') {
          queueState = 'exists';
          spec = classicSpec;
        } else if (
          fallback &&
          conformsToSpec(found.found, quorumSpec) === 'conforms'
        ) {
          queueState = 'exists';
          spec = quorumSpec;
        } else {
          failures.add('queue-wrong-shape');
        }
      } else if (profile.classicEnabled !== false) {
        queueState = 'will-create';
        spec = classicSpec;
      } else if (fallback) {
        queueState = 'will-create';
        spec = quorumSpec;
      } else {
        failures.add('classic-disabled-no-fallback');
      }
      const exists = queueState === 'exists';

      // 2. What policies would do to a queue of this name, and the room left.
      const needBytes = Math.max(
        profile.limits.maxMessageBytes ?? 0,
        RESCUE_BYTES_FLOOR,
      );
      let roomMessages: number | null = null;
      let roomBytes: number | null = null;
      let userMatches: readonly string[] = [];
      let operatorMatches: readonly string[] = [];
      if (spec !== null) {
        const { policies, operatorPolicies } = reads;
        if (
          policies.state === 'unreadable' ||
          operatorPolicies.state === 'unreadable'
        ) {
          failures.add('policies-unreadable');
        } else {
          const resolved = resolveHypothetical(
            {
              name: queueName,
              queueType: spec.arguments['x-queue-type'],
              version: profile.versions.min,
              args: spec.arguments,
              policies: policies.value.map(asDefinition),
              operatorPolicies: operatorPolicies.value.map(asDefinition),
              keys: SETTING_KEYS,
            },
            registry.effectiveConfig,
          );
          userMatches = resolved.userMatch.candidates;
          operatorMatches = resolved.operatorMatch.candidates;
          // What the registry rules decided (null: nothing sets it); undefined when they could not.
          const decided = (key: string): unknown => {
            const entry = resolved.entries[key];
            if (
              entry === undefined ||
              entry.status === 'unknown' ||
              entry.status === 'invalid'
            ) {
              failures.add('policy-undecided');
              return undefined;
            }
            return entry.value;
          };
          const overflow = decided('overflow');
          if (overflow !== undefined && overflow !== 'reject-publish') {
            failures.add('overflow');
          }
          const ttl = decided('message-ttl');
          if (ttl !== undefined && ttl !== null) failures.add('message-ttl');
          const expires = decided('expires');
          if (expires !== undefined && expires !== null) {
            failures.add('expires');
          }
          // Room under a limit; the held count of a queue we cannot read is "full" (fail closed).
          const room = (key: string, held: number | undefined) => {
            const limit = decided(key);
            if (limit === undefined || limit === null) return null;
            if (typeof limit !== 'number') {
              failures.add('policy-undecided');
              return null;
            }
            return Math.max(limit - (exists ? (held ?? limit) : 0), 0);
          };
          const present = found.state === 'present' ? found : null;
          roomMessages = room('max-length', present?.messages);
          roomBytes = room('max-length-bytes', present?.bytes);
          if (
            (roomMessages !== null && roomMessages < NEED_MESSAGES) ||
            (roomBytes !== null && roomBytes < needBytes)
          ) {
            failures.add('headroom');
          }
        }
      }

      // 3. The user's permission: write for a default-exchange publish, configure only to declare.
      const permission = reads.permission;
      if (permission.state === 'unreadable') {
        failures.add('permission-undecided');
      } else {
        // An empty pattern is not a pattern this code decides (what the broker does with it is not
        // in the fact sheet), so it is undecided and never a grant.
        const check = (pattern: string, name: string): boolean | null => {
          if (pattern === '') return null;
          const result = testPattern(pattern, name);
          return result.ok ? result.matches : null;
        };
        const writes = DEFAULT_EXCHANGE_NAMES.map((name) =>
          check(permission.value.write, name),
        );
        if (writes.includes(null)) failures.add('permission-undecided');
        if (writes.includes(false)) failures.add('permission-write');
        if (queueState === 'will-create') {
          const configure = check(permission.value.configure, queueName);
          if (configure === null) failures.add('permission-undecided');
          else if (!configure) failures.add('permission-configure');
        }
      }

      // 4. Alarms: a node in alarm blocks publishers, so the copy to the quarantine would hang.
      const nodes = reads.nodes;
      let alarmUnreadable = nodes.state === 'unreadable';
      const raised: string[] = [];
      if (nodes.state === 'read') {
        // An empty list is no broker; a node that does not say is not a node without an alarm.
        alarmUnreadable = nodes.value.length === 0;
        for (const node of nodes.value) {
          const name = node.name.slice(0, NAME_MAX);
          if (node.mem_alarm == null || node.disk_free_alarm == null) {
            alarmUnreadable = true;
          }
          if (node.mem_alarm === true) raised.push(`memory:${name}`);
          if (node.disk_free_alarm === true) raised.push(`disk:${name}`);
        }
      }
      if (raised.length > 0) failures.add('alarm');
      if (alarmUnreadable) failures.add('alarm-unreadable');
      const listed = alarmUnreadable ? ['alarm-unreadable', ...raised] : raised;
      const alarms = listed.slice(0, MAX_ALARMS);

      // 5. A blocked connection of ours; a list we may not read is reported, the arm step re-checks.
      const connections = reads.connections;
      const publishBlocked =
        connections.state === 'read' &&
        connections.value.some((row) => {
          const named = [row.name, row.client_properties?.connection_name];
          return (
            named.some((n) => typeof n === 'string' && n.startsWith(ours)) &&
            (row.state === 'blocked' || row.state === 'blocking')
          );
        });
      if (publishBlocked) failures.add('publish-blocked');

      const ready = queueState !== 'unavailable';
      const facts: RescueFacts = {
        queueName,
        queueReady: ready,
        overflowSafe: ![...failures].some((f) => SETTING_FAILURES.has(f)),
        permissionOk: ![...failures].some((f) => PERMISSION_FAILURES.has(f)),
        alarms,
        publishBlocked,
        checkedAt,
      };
      return {
        facts,
        queue: {
          state: queueState,
          declaredType:
            spec?.arguments['x-queue-type'] === 'quorum'
              ? 'quorum-unlimited'
              : 'classic',
          classicAssumed: queueState === 'will-create' && unknownClassic,
        },
        declare: queueState === 'will-create' ? spec : null,
        policyMatches: { user: userMatches, operator: operatorMatches },
        headroom: {
          messages: roomMessages,
          bytes: roomBytes,
          needMessages: NEED_MESSAGES,
          needBytes,
        },
        checks: {
          quarantine: found.state === 'unreadable' ? 'unreadable' : 'read',
          policies: checkOf(reads.policies),
          operatorPolicies: checkOf(reads.operatorPolicies),
          nodes: checkOf(reads.nodes),
          connections: checkOf(reads.connections),
          permission: checkOf(reads.permission),
          alarmsOmitted: listed.length - alarms.length,
        },
        failures: RESCUE_FAILURES.filter((f) => failures.has(f)),
      };
    },
  };
}
