// The peek preflight (M1-13 slice B, DC-06, blueprint 5.4): fills the planner's input with HTTP GET
// requests only. The deps hold a read port (the BrokerScheduler's wrapper, `interactive` lane, I-2,
// I-8) and an evidence port, nothing that can write. Reads and lists are bounded and a cut is counted
// (I-6, I-13); a field the broker did not send stays absent; the outcome holds numbers, names and
// closed codes, never a body or the broker's text (I-10).
import type { ConnectionId } from '@app/contracts';
import type { BrokerProfile } from '@app/domain-model';
import { AppError, type Clock } from '@app/kernel';
import type {
  DlxEvidence,
  PeekPreflight,
  PreflightQueue,
} from '@app/peek-planner';
import type {
  Lane,
  MgmtQuery,
  MgmtReadPort,
  PeekEvidencePort,
  Principal,
  QueuesEffectiveConfigOutput,
  RoutingDlxSourcesOutput,
} from '@app/ports';
import type { DeliveryLimit, LimitState } from '@app/semantics';
import type { z } from 'zod';

import {
  ConnectionListSchema,
  ConsumerListSchema,
  NodeListSchema,
  PermissionRowSchema,
  PolicyListSchema,
  QueueRowSchema,
  rowsOf,
  type ConnectionRow,
  type NodeRow,
  type PermissionRow,
  type PolicyRow,
  type QueueRow,
} from './preflight-rows.ts';
import { quarantineName, type FoundQueue } from './quarantine.ts';

const LANE: Lane = 'interactive';
/** The broker's own ceiling for a page; a list that needs another page is cut and counted. */
const PAGE: MgmtQuery = { page_size: 500 };
// Failures a best-effort call never swallows: the engine stopping, or the read budget spent.
const STOPS: ReadonlySet<string> = new Set([
  'ENGINE_SHUTTING_DOWN',
  'INTERNAL',
]);

export type PreflightProfile = Pick<
  BrokerProfile,
  'era' | 'versions' | 'identity' | 'classicEnabled' | 'limits'
>;

export interface PreflightLimits {
  /** Past it the policy list is unreadable: a cut list could hide the policy that decides. */
  readonly maxPolicies: number;
  readonly maxConsumerRows: number;
  readonly maxConnectionRows: number;
  /** A hard stop: the preflight reads at most this many times (an assertion of the spec too). */
  readonly maxReads: number;
}

export const DEFAULT_PREFLIGHT_LIMITS: PreflightLimits = {
  maxPolicies: 1_000,
  maxConsumerRows: 1_000,
  maxConnectionRows: 1_000,
  maxReads: 9,
};

export interface PeekPreflightDeps {
  /** The scheduler's read wrapper: no write port, no lease, no connection manager (I-2, I-8). */
  readonly mgmt: MgmtReadPort;
  readonly evidence: PeekEvidencePort;
  readonly clock: Clock;
  /** Injected by the composition root; a bad prefix fails at construction (OQ-1470). */
  readonly quarantinePrefix: string;
  readonly limits?: Partial<PreflightLimits>;
}

export interface PeekPreflightRequest {
  readonly connectionId: ConnectionId;
  readonly vhost: string;
  readonly queue: string;
  readonly principal: Principal;
  readonly profile: PreflightProfile;
  /** `check` when the plan may need the quarantine (a quorum queue with a finite or unknown limit). */
  readonly rescue: 'check' | 'skip';
}

/** A management list or row: read in full, or not (refused, failed, or past its bound). */
export type Read<T> =
  | { readonly state: 'read'; readonly value: T }
  | { readonly state: 'unreadable' };

export type QuarantineRead =
  | { readonly state: 'absent' }
  | {
      readonly state: 'present';
      readonly found: FoundQueue;
      readonly messages?: number;
      readonly bytes?: number;
    }
  | { readonly state: 'unreadable' };

/** What the rescue preflight judges: the quarantine queue and the broker's rules about it. */
export interface RescueReads {
  readonly quarantine: QuarantineRead;
  readonly policies: Read<readonly PolicyRow[]>;
  readonly operatorPolicies: Read<readonly PolicyRow[]>;
  readonly nodes: Read<readonly NodeRow[]>;
  readonly connections: Read<readonly ConnectionRow[]>;
  readonly permission: Read<PermissionRow>;
}

export interface PreflightOutcome {
  /** Handed to `planPeek` unchanged. */
  readonly preflight: PeekPreflight;
  /** Null when the caller asked to `skip` the rescue check. */
  readonly reads: RescueReads | null;
  readonly quarantineName: string;
  /** Rows read but not used because of a bound; a minimum when the broker gave no total. */
  readonly cut: {
    readonly consumers: number;
    readonly policies: number;
    readonly operatorPolicies: number;
    readonly connections: number;
  };
}

export interface PeekPreflightService {
  run(
    request: PeekPreflightRequest,
    signal: AbortSignal,
  ): Promise<PreflightOutcome>;
}

type Entry = NonNullable<
  QueuesEffectiveConfigOutput['effective']
>['entries'][string];
type Table = Readonly<Record<string, unknown>>;

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
const lowest = (values: readonly unknown[]): number | undefined => {
  const found = values.map(count).filter((v) => v !== undefined);
  return found.length === 0 ? undefined : Math.min(...found);
};
const positiveInt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
    ? value
    : undefined;

/** The delivery-limit stat: a positive integer, an explicit "unlimited", or unknown. */
function statLimit(raw: number | string | null | undefined): DeliveryLimit {
  if (raw === 'unlimited') return { kind: 'unlimited' };
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return { kind: 'unknown' };
  }
  if (value < 0) return { kind: 'unlimited' };
  const finite = positiveInt(value);
  return finite === undefined
    ? { kind: 'unknown' }
    : { kind: 'finite', value: finite };
}

const TYPES = ['classic', 'quorum', 'stream'] as const;
const RETRY = ['disabled', 'all', 'failed', 'returned'] as const;
const OVERFLOWS = [
  'drop-head',
  'reject-publish-dlx',
  'reject-publish',
] as const;

const declaredType = (row: QueueRow): string => {
  const declared = row.arguments?.['x-queue-type'];
  return typeof declared === 'string' ? declared : '';
};

/** Unknown arguments count as single-active-consumer: the cautious reading. */
const isSingleActive = (row: QueueRow): boolean =>
  row.arguments == null || row.arguments['x-single-active-consumer'] === true;

/** Maps a queue row, and the effective configuration when the evidence port gave it, to planner input. */
export function queueFromRow(
  row: QueueRow,
  config: QueuesEffectiveConfigOutput | null,
  consumers: { readonly seen: number | undefined; readonly active: boolean },
): PreflightQueue {
  const args: Table = row.arguments ?? {};
  const policy: Table = row.effective_policy_definition ?? {};
  const entries = config?.effective?.entries ?? {};
  const decided = (key: string): Entry | undefined => {
    const entry = entries[key];
    const known = entry?.status === 'effective' || entry?.status === 'default';
    return known && entry.value !== null ? entry : undefined;
  };
  // The decided value when the registry rules decided one; else every source the row shows.
  const sources = (key: string, argument: string): unknown[] => {
    const entry = decided(key);
    return entry === undefined ? [args[argument], policy[key]] : [entry.value];
  };

  const type = TYPES.find((t) => t === (row.type ?? args['x-queue-type']));
  if (type === undefined) throw new AppError('BROKER_ERROR');
  const quorum = type === 'quorum';

  const delivery = entries['delivery-limit'];
  const limit: DeliveryLimit = quorum
    ? statLimit(row.delivery_limit)
    : { kind: 'unlimited' };
  const visible = new Set<number>();
  for (const candidate of [
    args['x-delivery-limit'],
    policy['delivery-limit'],
    ...(delivery?.provenance ?? []).map((p) => p.value),
  ]) {
    const value = positiveInt(candidate);
    if (value !== undefined) visible.add(value);
  }
  let limitState: LimitState = quorum ? 'finite' : 'unset';
  if (quorum && limit.kind === 'unlimited') {
    // `-1` is destructive on one era and `unset` is not, so unlimited is `unset` only when the
    // rules decided it or nothing (argument, policy, operator policy) could have set it.
    const noSource =
      row.arguments != null &&
      args['x-delivery-limit'] === undefined &&
      row.policy === null &&
      row.operator_policy === null;
    limitState = delivery?.status === 'unset' || noSource ? 'unset' : 'minus1';
  }
  // Who fixes the limit decides whether a policy can raise it (A-4); an unknown fixer fails closed.
  const layer = delivery?.provenance.find((p) => p.role === 'deciding')?.layer;
  const status = delivery?.status;
  let limitFixedBy: 'argument' | 'operator-policy' | null = null;
  if (status !== undefined && status !== 'unknown' && status !== 'invalid') {
    if (layer === 'argument' || layer === 'operator-policy')
      limitFixedBy = layer;
  } else if (args['x-delivery-limit'] !== undefined) {
    limitFixedBy = 'argument';
  } else if (row.operator_policy !== null) {
    limitFixedBy = 'operator-policy';
  }

  const sac = isSingleActive(row);
  const ready = count(row.messages_ready);
  const bytes = count(row.message_bytes_ready);
  const avgBytes =
    ready !== undefined && ready > 0 && bytes !== undefined
      ? bytes / ready
      : undefined;
  const { members, online } = row;
  const quorumOk =
    !quorum || members == null || online == null
      ? undefined
      : (row.leader ?? '') !== '' && online.length * 2 > members.length;
  const retry = [
    row.delayed_retry,
    decided('delayed-retry-type')?.value,
    args['x-delayed-retry-type'],
  ].find((v) => v != null);
  const retryType = RETRY.find((t) => t === retry);
  const overflows = sources('overflow', 'x-overflow');
  const overflow = OVERFLOWS.find((o) => overflows.includes(o));
  const ttlMs = lowest(sources('message-ttl', 'x-message-ttl'));
  const maxLength = lowest(sources('max-length', 'x-max-length'));
  const timeoutMs = lowest(sources('consumer-timeout', 'x-consumer-timeout'));
  const seen = count(row.consumers) ?? consumers.seen ?? 0;

  return {
    type,
    exclusiveOwnedByOther: row.exclusive === true,
    autoDelete: row.auto_delete === true,
    deliveryLimit: limit,
    limitState,
    limitFixedBy,
    ...(visible.size === 0
      ? {}
      : { visibleLimits: [...visible].sort((a, b) => a - b) }),
    singleActiveConsumer: sac,
    hasActiveConsumer: sac ? consumers.active : seen > 0,
    consumers: seen,
    ...(ready === undefined ? {} : { ready }),
    ...(quorumOk === undefined ? {} : { quorumOk }),
    ...(avgBytes === undefined || !Number.isFinite(avgBytes)
      ? {}
      : { avgBytes }),
    ...(retryType === undefined ? {} : { delayedRetry: { type: retryType } }),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(overflow === undefined ? {} : { overflow }),
    ...(ttlMs === undefined ? {} : { ttlMs }),
    ...(timeoutMs === undefined ? {} : { consumerTimeoutMs: timeoutMs }),
  };
}

/** What the planner is told when the evidence could not be read: incomplete, never "no hazard". */
const EVIDENCE_GAP: DlxEvidence = {
  sources: [],
  complete: false,
  unknownReasons: [{ code: 'evidence-unavailable' }],
};

function dlxFrom(answer: RoutingDlxSourcesOutput | null): DlxEvidence {
  if (answer === null) return EVIDENCE_GAP;
  // A list cut at its bound could hide the source that matters: it is not complete.
  const cut = answer.sourcesMore > 0;
  const reasons = answer.unknownReasons.map((reason) => ({
    code: reason.code,
    ...(reason.subject === undefined ? {} : { subject: reason.subject }),
  }));
  return {
    sources: answer.sources.map((s) => ({ queue: s.queue, limit: s.limit })),
    complete: answer.complete && !cut,
    unknownReasons: cut ? [...reasons, { code: 'truncated' }] : reasons,
  };
}

export function createPeekPreflight(
  deps: PeekPreflightDeps,
): PeekPreflightService {
  const limits: PreflightLimits = {
    ...DEFAULT_PREFLIGHT_LIMITS,
    ...deps.limits,
  };
  // A bad prefix fails here, at construction, and not at the first peek (OQ-1470).
  const quarantine = quarantineName(deps.quarantinePrefix);
  const { clock } = deps;

  return {
    async run(request, signal) {
      const { connectionId, vhost, queue, principal, profile } = request;
      const enc = encodeURIComponent(vhost);
      let used = 0;

      const get = async <T>(
        path: string,
        schema: z.ZodType<T>,
        query?: MgmtQuery,
      ): Promise<T> => {
        if (used >= limits.maxReads) throw new AppError('INTERNAL');
        used += 1;
        try {
          const request = { connectionId, path, schema, lane: LANE };
          return await deps.mgmt.get(
            query ? { ...request, query } : request,
            signal,
          );
        } catch (error) {
          if (signal.aborted || error instanceof AppError) throw error;
          // Never the cause: a body or a header could be in its text.
          throw new AppError('BROKER_ERROR');
        }
      };
      /** A best-effort call: null when it failed; a shutdown or an abort is never swallowed. */
      const soft = async <T>(call: () => Promise<T>): Promise<T | null> => {
        try {
          return await call();
        } catch (error) {
          if (
            signal.aborted ||
            (error instanceof AppError && STOPS.has(error.code))
          ) {
            throw error;
          }
          return null;
        }
      };

      const queuePath = (name: string): string =>
        `/api/queues/${enc}/${encodeURIComponent(name)}`;
      const started = clock.monotonic();
      const row = await get(queuePath(queue), QueueRowSchema, {
        enable_queue_totals: true,
      });
      const elapsed = clock.monotonic() - started;
      const rttMs = Number.isFinite(elapsed) && elapsed >= 1 ? elapsed : 1;

      // Only a single-active-consumer queue needs the consumer list (basic.get is refused there).
      const sac = isSingleActive(row);
      const cut = {
        consumers: 0,
        policies: 0,
        operatorPolicies: 0,
        connections: 0,
      };
      type CutKey = keyof typeof cut;
      /** A list read up to `bound` rows; the rows past it, or on another page, are counted in `cut`. */
      const listed = async <S, T>(
        key: CutKey,
        path: string,
        schema: z.ZodType<S>,
        pick: (answer: S) => { rows: readonly T[]; more: number },
        bound: number,
        query: MgmtQuery = PAGE,
      ): Promise<readonly T[]> => {
        const { rows, more } = pick(await get(path, schema, query));
        cut[key] = Math.max(rows.length - bound, 0) + more;
        return rows.slice(0, bound);
      };
      const readOf = async <T>(call: () => Promise<T>): Promise<Read<T>> => {
        const value = await soft(call);
        return value === null
          ? { state: 'unreadable' }
          : { state: 'read', value };
      };
      const policyList = (key: 'policies' | 'operatorPolicies', path: string) =>
        readOf(async () => {
          const rows = await listed(
            key,
            path,
            PolicyListSchema,
            rowsOf,
            limits.maxPolicies,
          );
          // A cut list could hide the policy that decides: it is unreadable, and counted.
          if (cut[key] > 0) throw new AppError('BUDGET_EXCEEDED');
          return rows;
        });
      const quarantineRead = async (): Promise<QuarantineRead> => {
        try {
          const f = await get(queuePath(quarantine), QueueRowSchema, {
            enable_queue_totals: true,
          });
          const messages = count(f.messages);
          const bytes = count(f.message_bytes);
          return {
            state: 'present',
            found: {
              name: f.name,
              vhost,
              type: f.type ?? declaredType(f),
              durable: f.durable === true,
              autoDelete: f.auto_delete !== false,
              ...(f.exclusive == null ? {} : { exclusive: f.exclusive }),
              arguments: f.arguments ?? {},
            },
            ...(messages === undefined ? {} : { messages }),
            ...(bytes === undefined ? {} : { bytes }),
          };
        } catch (error) {
          if (error instanceof AppError && error.code === 'NOT_FOUND') {
            return { state: 'absent' };
          }
          if (
            signal.aborted ||
            (error instanceof AppError && STOPS.has(error.code))
          ) {
            throw error;
          }
          return { state: 'unreadable' };
        }
      };
      const rescueReads = async (): Promise<RescueReads> => ({
        quarantine: await quarantineRead(),
        policies: await policyList('policies', `/api/policies/${enc}`),
        operatorPolicies: await policyList(
          'operatorPolicies',
          `/api/operator-policies/${enc}`,
        ),
        nodes: await readOf(async () => {
          const { rows, more } = rowsOf(
            await get('/api/nodes', NodeListSchema, {
              columns: 'name,mem_alarm,disk_free_alarm',
              ...PAGE,
            }),
          );
          // A node that was not listed may be the one in alarm.
          if (more > 0) throw new AppError('BUDGET_EXCEEDED');
          return rows;
        }),
        connections: await readOf(() =>
          listed(
            'connections',
            `/api/vhosts/${enc}/connections`,
            ConnectionListSchema,
            rowsOf,
            limits.maxConnectionRows,
            { columns: 'name,state,client_properties', ...PAGE },
          ),
        ),
        permission: await readOf(() =>
          get(
            `/api/permissions/${enc}/${encodeURIComponent(profile.identity.user)}`,
            PermissionRowSchema,
          ),
        ),
      });

      const evidence = { connectionId, vhost, queue };
      const [consumerRows, dlx, config, reads] = await Promise.all([
        sac
          ? soft(() =>
              listed(
                'consumers',
                `/api/consumers/${enc}`,
                ConsumerListSchema,
                rowsOf,
                limits.maxConsumerRows,
              ),
            )
          : Promise.resolve([]),
        soft(() => deps.evidence.dlxSources(evidence, principal, signal)),
        soft(() => deps.evidence.effectiveConfig(evidence, principal, signal)),
        request.rescue === 'check' ? rescueReads() : Promise.resolve(null),
      ]);

      const ours = consumerRows?.filter((c) => c.queue.name === queue);
      // Fail closed: a list that is unreadable or cut may hide the consumer that makes the queue busy.
      const active =
        ours === undefined ||
        cut.consumers > 0 ||
        ours.some((c) => c.active !== false);
      return {
        preflight: {
          queue: queueFromRow(row, config, { seen: ours?.length, active }),
          dlxSources: dlxFrom(dlx),
          rttMs,
          takenAt: clock.now(),
        },
        reads,
        quarantineName: quarantine,
        cut,
      };
    },
  };
}
