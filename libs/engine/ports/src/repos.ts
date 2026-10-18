// Repository ports. Every method is async from day one (blueprint I-5), so SQLite can move to a
// storage worker without touching a caller, and no method returns an unbounded collection (I-7):
// lists are windows.
import type { JobId } from '@app/contracts';

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
