// The receipt store (blueprint 5.10, I-13): every mutation and every peek leaves a receipt that the
// audit log links to. The store records what the executor knows (who, what, under which plan, with
// which result, which audit attempt row) and a structured `detail` that the actions with something
// to say (per-message outcomes, anomalies, warnings) fill in M1.
//
// Nothing here is lossy: a `detail` that is too large is refused, not cut, so the executor flags the
// result `receiptFailed` and the audit outcome row says so. Every string is redacted first (I-10).
import type { ReceiptId } from '@app/contracts';
import type { ReceiptRecord, ReceiptRepository } from '@app/ports';

import { encodeValue } from '../actions/canonical.ts';
import type { ExecutionRecord, ReceiptSink } from '../actions/hooks.ts';
import type { Clock } from '../clock/clock.ts';
import type { IdGenerator } from '../ids/ids.ts';
import { scrubJson, scrubText } from '../log/scrub.ts';

/** The most a receipt's structured part may take (canonical JSON, bytes). */
export const MAX_RECEIPT_DETAIL_BYTES = 1024 * 1024;

export interface ReceiptStore extends ReceiptSink {
  get(id: ReceiptId): Promise<ReceiptView | undefined>;
  /** Retention (90 days): deletes at most `limit` receipts created before `cutoff`. */
  purgeBefore(cutoff: number, limit: number): Promise<number>;
}

/** A receipt as callers read it: the detail is parsed. */
export interface ReceiptView extends Omit<ReceiptRecord, 'detailJson'> {
  readonly detail: unknown;
}

export interface ReceiptStoreOptions {
  repository: ReceiptRepository;
  clock: Clock;
  ids: IdGenerator;
}

function detailOf(detail: unknown): string {
  // The size is checked on the raw value, before any pattern runs over it.
  const raw = encodeValue(detail ?? {});
  if (Buffer.byteLength(raw, 'utf8') > MAX_RECEIPT_DETAIL_BYTES) {
    throw new RangeError('The receipt detail is too large to store.');
  }
  // Sensitive keys (body, payload, token, ...) lose their value at any depth; strings are scrubbed
  // and a string too long to scrub is replaced by a marker, never stored whole.
  // `raw` already has sorted keys and tagged bigint and bytes, which JSON.stringify keeps as they are.
  return JSON.stringify(scrubJson(JSON.parse(raw) as unknown));
}

export function createReceiptStore(options: ReceiptStoreOptions): ReceiptStore {
  const { repository, clock, ids } = options;
  return {
    async record(execution: ExecutionRecord): Promise<ReceiptId> {
      const record: ReceiptRecord = {
        id: ids.receiptId(),
        actionId: execution.actionId,
        planId: execution.planId ?? null,
        planDigest: execution.planDigest ?? null,
        principalId: scrubText(execution.principal.id, 256),
        onBehalfOfId:
          execution.principal.onBehalfOf === undefined
            ? null
            : scrubText(execution.principal.onBehalfOf.id, 256),
        correlationId: scrubText(execution.correlationId, 128),
        env: execution.env,
        risk: execution.risk,
        startedAt: execution.startedAt,
        finishedAt: execution.finishedAt,
        result: execution.result,
        code: execution.code ?? null,
        jobId: execution.jobId ?? null,
        auditSeq: execution.auditSeq ?? null,
        detailJson: detailOf(execution.detail),
        createdAt: clock.now(),
      };
      await repository.insert(record);
      return record.id;
    },

    async get(id) {
      const record = await repository.get(id);
      if (record === undefined) return undefined;
      const { detailJson, ...rest } = record;
      return { ...rest, detail: JSON.parse(detailJson) as unknown };
    },

    purgeBefore: (cutoff, limit) => repository.purgeBefore(cutoff, limit),
  };
}
