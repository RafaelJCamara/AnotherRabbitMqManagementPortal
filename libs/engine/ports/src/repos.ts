// Repository ports. Every method is async from day one (blueprint I-5), so SQLite can move to a
// storage worker without touching a caller, and no method returns an unbounded collection (I-7):
// lists are windows.
import type {
  ActionId,
  EnvClass,
  JobId,
  PlanId,
  ReceiptId,
  Risk,
} from '@app/contracts';

import type { Principal } from './connection-manager.ts';

/** A window over an ordered collection. `nextCursor` is absent on the last window. */
export interface Window<T> {
  items: readonly T[];
  nextCursor?: string;
}

export interface WindowQuery {
  /** At most this many items (the repository clamps it to its own maximum). */
  limit: number;
  cursor?: string;
}

export interface JobRecord {
  id: JobId;
  type: string;
  state:
    | 'queued'
    | 'running'
    | 'paused'
    | 'paused-interrupted'
    | 'awaiting-credentials'
    | 'succeeded'
    | 'failed'
    | 'cancelled';
  principal: Principal;
  planHash?: string;
  idempotencyKey: string;
  leaseOwner?: string;
  leaseUntil?: number;
  attempts: number;
  checkpoint?: unknown;
}

export interface JobStore {
  create(record: Omit<JobRecord, 'id' | 'state' | 'attempts'>): Promise<JobId>;
  /** Claims one runnable job for `owner` (`FOR UPDATE SKIP LOCKED` on Postgres). */
  claim(
    owner: string,
    leaseMs: number,
    types: readonly string[],
  ): Promise<JobRecord | undefined>;
  heartbeat(id: JobId, owner: string, leaseMs: number): Promise<boolean>;
  saveCheckpoint(id: JobId, checkpoint: unknown): Promise<void>;
  setState(
    id: JobId,
    state: JobRecord['state'],
    reason?: string,
  ): Promise<void>;
}

export type JournalState =
  | 'consumed'
  | 'published'
  | 'confirmed'
  | 'acked'
  | 'parked'
  | 'returned'
  | 'uncertain-duplicate'
  | 'error';

export interface ReplayJournalEntry {
  jobId: JobId;
  occurrenceKey: string;
  ordinal: number;
  logicalId?: string;
  fingerprint: string;
  state: JournalState;
  publishSeq?: number;
  replayId: string;
  at: number;
  copyRef?: string;
}

export interface ReplayJournal {
  append(entry: ReplayJournalEntry): Promise<void>;
  /** A multiset per key. */
  counts(key: string): Promise<{
    consumed: number;
    published: number;
    acked: number;
    parked: number;
  }>;
  /** When in doubt: republish (a duplicate is recoverable, a loss is not). */
  decideOnRedelivery(
    key: string,
    headers: Record<string, unknown>,
  ): Promise<'ack-without-republish' | 'republish'>;
}

// ---------------------------------------------------------------------------------------------
// Plans and idempotency keys (M0-29). The ActionExecutor's PlanStore (kernel) holds the policy
// (TTLs, states, approvals, digests); these ports only store and compare-and-set rows. An adapter
// (persistence) implements them; the kernel never imports an adapter.
// ---------------------------------------------------------------------------------------------

export type PlanState =
  | 'open'
  | 'awaiting-approval'
  | 'approved'
  | 'executing'
  | 'executed'
  | 'failed'
  | 'expired'
  | 'rejected';

export interface PlanApprovalRecord {
  readonly by: string;
  readonly at: number;
  readonly decision: 'approve' | 'reject';
  /** The plan digest the approver saw: an approval of another digest does not count. */
  readonly digest: string;
  /**
   * Authenticated ciphertext (base64) over this approval, made by the kernel. A row edited in the
   * database by someone without the key cannot carry a valid one.
   */
  readonly seal: string;
  readonly note?: string;
}

/** One stored plan. `payload` is ciphertext (or null once purged); everything else is plain. */
export interface PlanRecord {
  readonly id: PlanId;
  readonly actionId: ActionId;
  readonly inputHash: string;
  /** sha256 over every field the plan is bound to; kept after the payload is purged. */
  readonly digest: string;
  readonly principalId: string;
  readonly onBehalfOfId: string | null;
  readonly profileFingerprint: string | null;
  readonly env: EnvClass;
  readonly risk: Risk;
  readonly state: PlanState;
  readonly approvalsRequired: number;
  readonly approvals: readonly PlanApprovalRecord[];
  /** Canonical JSON text, written and validated by the kernel: the store never interprets it. */
  readonly gatesJson: string;
  readonly warningsJson: string;
  readonly previewJson: string;
  readonly consentsRequired: readonly string[];
  readonly confirmationPhrase: string | null;
  readonly payload: Uint8Array | null;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Starts at 1; every successful `update` adds 1. The compare-and-set token. */
  readonly version: number;
}

/** The fields a state change may touch. */
export interface PlanPatch {
  readonly state?: PlanState;
  readonly approvals?: readonly PlanApprovalRecord[];
  readonly payload?: Uint8Array | null;
  readonly expiresAt?: number;
}

export interface PlanRepository {
  /** Stores a new plan. Rejects when the id exists. */
  insert(record: PlanRecord): Promise<void>;
  get(id: PlanId): Promise<PlanRecord | undefined>;
  /**
   * Applies `patch` only when the stored version is `expectedVersion` (compare-and-set), stamps
   * `updatedAt` and adds 1 to the version. Returns the new row, or undefined when the row is gone
   * or someone else changed it first.
   */
  update(
    id: PlanId,
    expectedVersion: number,
    patch: PlanPatch,
    now: number,
  ): Promise<PlanRecord | undefined>;
  /** Plans of a principal that are open, awaiting approval, approved or executing and not yet due. */
  countActive(principalId: string, now: number): Promise<number>;
  /**
   * Marks at most `limit` open, awaiting-approval or approved plans whose `expiresAt` has passed as
   * expired and drops their payload. Returns how many it changed.
   */
  expireDue(now: number, limit: number): Promise<number>;
  /** Deletes at most `limit` finished plans last touched before `cutoff` (retention). */
  purgeBefore(cutoff: number, limit: number): Promise<number>;
}

// ---------------------------------------------------------------------------------------------
// The audit chain and receipts (M0-30). The kernel owns the hash chain (what is hashed, how a
// break is found); these ports only store rows, in order, and never update or delete one.
// ---------------------------------------------------------------------------------------------

/**
 * One row of the audit chain. The JSON members are canonical text written by the kernel and are
 * hashed as text, so any edit, even whitespace, changes the hash. `hash` covers every other member.
 */
export interface AuditRow {
  /** 1, 2, 3, ... with no gap; assigned by the kernel, unique in the store. */
  readonly seq: number;
  readonly at: number;
  readonly phase: 'attempt' | 'outcome';
  readonly correlationId: string;
  readonly actionId: string;
  readonly kind: string;
  readonly actorId: string;
  readonly surface: string;
  readonly onBehalfOfId: string | null;
  /** The principal at the time, with whoever it acted for. */
  readonly actorJson: string;
  readonly targetJson: string;
  readonly env: string;
  readonly risk: string;
  readonly planId: string | null;
  readonly planDigest: string | null;
  /** The ids of the principals whose approval the plan carried (a JSON array). */
  readonly approvedByJson: string;
  /** On an outcome row: the `seq` of the attempt row it closes. */
  readonly attemptSeq: number | null;
  readonly result: 'ok' | 'error' | null;
  readonly code: string | null;
  readonly jobId: string | null;
  readonly receiptId: string | null;
  /** Masked, bounded flags and counters (a JSON object). Never an input or a message body. */
  readonly detailJson: string;
  readonly prevHash: string;
  readonly hash: string;
}

export interface AuditHead {
  readonly seq: number;
  readonly hash: string;
}

/** Append-only. A store offers no update and no delete: retention is a separate, privileged job. */
export interface AuditRepository {
  /** The last row's `seq` and `hash`; undefined for an empty chain. */
  head(): Promise<AuditHead | undefined>;
  /**
   * Appends `row`. Returns false, and stores nothing, when a row with that `seq` or that `prevHash`
   * exists (another writer got there first): the caller reads the head again and retries.
   */
  append(row: AuditRow): Promise<boolean>;
  /** Rows with `seq` greater than `afterSeq`, ascending; at most `limit` (clamped to 1,000). */
  window(afterSeq: number, limit: number): Promise<readonly AuditRow[]>;
}

/** One receipt (blueprint 5.10). `detailJson` is the structured part, written by the action. */
export interface ReceiptRecord {
  readonly id: ReceiptId;
  readonly actionId: ActionId;
  readonly planId: PlanId | null;
  readonly planDigest: string | null;
  readonly principalId: string;
  readonly onBehalfOfId: string | null;
  readonly correlationId: string;
  readonly env: EnvClass;
  readonly risk: Risk;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly result: 'ok' | 'error';
  readonly code: string | null;
  readonly jobId: JobId | null;
  /** The `seq` of the audit attempt row of the same execution, when it had one. */
  readonly auditSeq: number | null;
  readonly detailJson: string;
  readonly createdAt: number;
}

export interface ReceiptRepository {
  /** Stores a new receipt. Rejects when the id exists. */
  insert(record: ReceiptRecord): Promise<void>;
  get(id: ReceiptId): Promise<ReceiptRecord | undefined>;
  /** Deletes at most `limit` receipts created before `cutoff` (retention, 90 days). */
  purgeBefore(cutoff: number, limit: number): Promise<number>;
}

/** Idempotency keys are scoped to the principal that sent them: nobody can burn another's key. */
export interface IdempotencyRepository {
  /** True when the key was new and is now taken; false when it was already used. Atomic. */
  claim(
    principalId: string,
    key: string,
    info: { actionId: ActionId; planId: PlanId | null; at: number },
  ): Promise<boolean>;
  has(principalId: string, key: string): Promise<boolean>;
  /** Deletes the keys taken before `cutoff` (retention). Returns how many. */
  purgeBefore(cutoff: number): Promise<number>;
}
