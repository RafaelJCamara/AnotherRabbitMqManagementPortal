// The hash-chained audit (ADR-006 step 10 and 12, blueprint 5.1, threat T9).
//
//   attempt   written BEFORE an action runs. If the write fails the action is denied: the executor
//             treats a rejection as "do not run", and a write that is still pending is a rejection.
//   outcome   written after the action ran. The action cannot be undone, so a failed write is
//             reported (the result carries `auditOutcomeFailed`), logged, and kept in a bounded
//             queue that is written, in order, before the next row (OQ-244, OQ-272). A full queue
//             refuses the next attempt: the chain never silently drops an outcome while it is up.
//   verify    walks the chain and reports the first seq at which it does not hold. Without an
//             anchor it cannot see a truncated tail or a chain rewritten from some row to the end;
//             the head (`head()`) is what an external anchor stores, and `expect` checks it (OQ-273).
//
// One writer at a time per process (a promise chain). Several processes on one Postgres race on the
// primary key of `seq` and the unique `prevHash`: the loser reads the head again and retries, so the
// chain never forks.
import type { AuditHead, AuditRepository, AuditRow } from '@app/ports';

import type { AuditEntry, AuditOutcome, AuditSink } from '../actions/hooks.ts';
import { BoundedQueue } from '../bounded/index.ts';
import type { Logger } from '../log/logger.ts';
import {
  attemptBody,
  AUDIT_GENESIS_HASH,
  hashAuditRow,
  outcomeBody,
  sealRow,
  type AuditRowBody,
} from './row.ts';

export type AuditBreak =
  /** A row is missing, repeated or out of order: the expected seq is not there. */
  | 'seq-gap'
  /** The stored hash is not the hash of the row's columns: the row was edited. */
  | 'hash-mismatch'
  /** The row's `prevHash` is not the hash of the row before. */
  | 'prev-mismatch'
  /** The row cannot be hashed (a column of the wrong type). */
  | 'malformed'
  /** The row at the expected head has a different hash. */
  | 'anchor-mismatch'
  /** The chain ends before the expected head. */
  | 'truncated';

export type AuditVerification =
  | { ok: true; rows: number; head: AuditHead | undefined }
  | { ok: false; brokenSeq: number; reason: AuditBreak; rows: number };

export interface VerifyOptions {
  /** Start after this row, trusting its hash: how a chain is checked after retention deleted a prefix. */
  from?: AuditHead | undefined;
  /** The head an external anchor recorded. The chain must reach it with the same hash. */
  expect?: AuditHead | undefined;
  /** Rows read per query. Default 500. */
  pageSize?: number | undefined;
}

export interface AuditChainStats {
  /** Outcome rows waiting for the store to come back. */
  pending: number;
  /** Outcome rows that did not fit the queue and are lost (also logged). Should stay 0. */
  pendingDropped: number;
}

export interface AuditChain extends AuditSink {
  head(): Promise<AuditHead | undefined>;
  verify(options?: VerifyOptions): Promise<AuditVerification>;
  /** Writes the queued outcome rows now; resolves with what was written and what is still queued. */
  flushPending(): Promise<{ written: number; pending: number }>;
  stats(): AuditChainStats;
}

export interface AuditChainOptions {
  repository: AuditRepository;
  logger?: Logger;
  /** Outcome rows kept while the store is down. Default 1,000. */
  maxPending?: number;
  /** Lost races tolerated before an append gives up. Default 64. */
  maxAppendTries?: number;
}

const DEFAULT_PAGE = 500;
const DEFAULT_PENDING = 1000;
// A lost race means another writer made progress, so a writer can starve only while others keep
// winning; 64 covers a busy team server and still ends (the action is then denied).
const DEFAULT_TRIES = 64;

/** Every column but the hash, exactly as stored: an extra member of a returned row is hashed too. */
function withoutHash(row: AuditRow): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...row };
  delete copy.hash;
  return copy;
}

export function createAuditChain(options: AuditChainOptions): AuditChain {
  const { repository, logger } = options;
  const maxTries = options.maxAppendTries ?? DEFAULT_TRIES;
  const pending = new BoundedQueue<AuditRowBody>({
    maxItems: options.maxPending ?? DEFAULT_PENDING,
    // A body is a few hundred bytes of text; the size is its JSON, so the byte bound is real.
    maxBytes: (options.maxPending ?? DEFAULT_PENDING) * 16_384,
    sizeOf: (body) => JSON.stringify(body).length,
    onDrop: ({ reason, items }) => {
      logger?.error(
        { event: 'audit.outcome.dropped', reason, items },
        'an audit outcome row was lost because the retry queue is full',
      );
    },
  });

  // ---- one writer at a time -------------------------------------------------------------------
  let tail: Promise<unknown> = Promise.resolve();
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work);
    tail = result.catch(() => undefined);
    return result;
  }

  async function append(body: AuditRowBody): Promise<number> {
    for (let attempt = 0; attempt < maxTries; attempt += 1) {
      const head = await repository.head();
      if (head !== undefined && !Number.isSafeInteger(head.seq)) {
        throw new RangeError('The audit head has no valid seq.');
      }
      const seq = head === undefined ? 1 : head.seq + 1;
      const row = sealRow(body, seq, head?.hash ?? AUDIT_GENESIS_HASH);
      if (await repository.append(row)) return seq;
      // Another writer took this seq: read the head again.
    }
    throw new Error('The audit chain could not be appended to (lost races).');
  }

  async function writePending(): Promise<number> {
    let written = 0;
    for (let body = pending.peek(); body !== undefined; body = pending.peek()) {
      await append(body);
      pending.shift();
      written += 1;
    }
    return written;
  }

  return {
    attempt(entry: AuditEntry) {
      return exclusive(async () => {
        // A row that cannot be built (a value that cannot be stored) is a rejection, like a dead
        // disk: the action is denied.
        const body = attemptBody(entry);
        // Queued outcomes come first, so the chain keeps the order the actions finished in. If
        // they cannot be written the store is not healthy: deny.
        await writePending();
        return append(body);
      });
    },

    outcome(entry: AuditOutcome) {
      return exclusive(async () => {
        const body = outcomeBody(entry);
        try {
          await writePending();
          await append(body);
        } catch (error) {
          // The action ran. Keep the row to write later, and tell the caller it is not there yet.
          pending.offer(body);
          throw error;
        }
      });
    },

    head: () => repository.head(),

    async verify(verifyOptions: VerifyOptions = {}) {
      const pageSize = Math.max(
        1,
        Math.min(verifyOptions.pageSize ?? DEFAULT_PAGE, 1000),
      );
      const { expect: expected } = verifyOptions;
      let after = verifyOptions.from?.seq ?? 0;
      let prevHash = verifyOptions.from?.hash ?? AUDIT_GENESIS_HASH;
      let next = after + 1;
      let rows = 0;
      let last: AuditHead | undefined = verifyOptions.from;
      const broken = (brokenSeq: number, reason: AuditBreak) =>
        ({ ok: false, brokenSeq, reason, rows }) as const;

      for (;;) {
        const page = await repository.window(after, pageSize);
        if (page.length === 0) break;
        for (const row of page) {
          if (row.seq !== next) return broken(next, 'seq-gap');
          let recomputed: string;
          try {
            recomputed = hashAuditRow(withoutHash(row));
          } catch {
            return broken(row.seq, 'malformed');
          }
          if (recomputed !== row.hash) return broken(row.seq, 'hash-mismatch');
          if (row.prevHash !== prevHash) {
            return broken(row.seq, 'prev-mismatch');
          }
          if (expected?.seq === row.seq && row.hash !== expected.hash) {
            return broken(row.seq, 'anchor-mismatch');
          }
          prevHash = row.hash;
          last = { seq: row.seq, hash: row.hash };
          next += 1;
          rows += 1;
        }
        after = next - 1;
      }
      if (expected !== undefined && next - 1 < expected.seq) {
        return broken(next, 'truncated');
      }
      return { ok: true, rows, head: last } as const;
    },

    flushPending: () =>
      exclusive(async () => {
        let written = 0;
        try {
          written = await writePending();
        } catch (error) {
          logger?.warn(
            {
              event: 'audit.flush.failed',
              pending: pending.size,
              cause: error instanceof Error ? error.name : 'unknown',
            },
            'queued audit outcome rows could not be written',
          );
        }
        return { written, pending: pending.size };
      }),

    stats: () => ({ pending: pending.size, pendingDropped: pending.dropped }),
  };
}
