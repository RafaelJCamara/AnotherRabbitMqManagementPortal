// The Kysely implementation of the audit and receipt ports of @app/ports (M0-30). It stores rows
// in order and never updates or deletes an audit row (the triggers of 0003 reject both); what is
// hashed and how a break is found is the kernel's audit chain.
import type {
  ActionId,
  EnvClass,
  JobId,
  PlanId,
  ReceiptId,
  Risk,
} from '@app/contracts';
import type {
  AuditHead,
  AuditRepository,
  AuditRow,
  ReceiptRecord,
  ReceiptRepository,
} from '@app/ports';
import type { Kysely, Selectable } from 'kysely';

import type { AuditEventsTable, Database, ReceiptsTable } from '../database';

/** The most rows one `window` call returns (I-7: nothing here lists "all"). */
export const MAX_AUDIT_WINDOW = 1000;

function toAuditRow(row: Selectable<AuditEventsTable>): AuditRow {
  return {
    seq: row.seq,
    at: row.at,
    phase: row.phase as AuditRow['phase'],
    correlationId: row.correlation_id,
    actionId: row.action_id,
    kind: row.kind,
    actorId: row.actor_id,
    surface: row.surface,
    onBehalfOfId: row.on_behalf_of_id,
    actorJson: row.actor,
    targetJson: row.target,
    env: row.env,
    risk: row.risk,
    planId: row.plan_id,
    planDigest: row.plan_digest,
    approvedByJson: row.approved_by,
    attemptSeq: row.attempt_seq,
    result: row.result as AuditRow['result'],
    code: row.code,
    jobId: row.job_id,
    receiptId: row.receipt_id,
    detailJson: row.detail,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

export function createAuditRepository(db: Kysely<Database>): AuditRepository {
  return {
    async head(): Promise<AuditHead | undefined> {
      const row = await db
        .selectFrom('audit_events')
        .select(['seq', 'hash'])
        .orderBy('seq', 'desc')
        .limit(1)
        .executeTakeFirst();
      return row === undefined ? undefined : { seq: row.seq, hash: row.hash };
    },

    async append(row) {
      // ON CONFLICT DO NOTHING covers both keys of the chain: `seq` and `prev_hash`. A writer that
      // lost the race inserts nothing and is told so; it reads the head again.
      const result = await db
        .insertInto('audit_events')
        .values({
          seq: row.seq,
          at: row.at,
          phase: row.phase,
          correlation_id: row.correlationId,
          action_id: row.actionId,
          kind: row.kind,
          actor_id: row.actorId,
          surface: row.surface,
          on_behalf_of_id: row.onBehalfOfId,
          actor: row.actorJson,
          target: row.targetJson,
          env: row.env,
          risk: row.risk,
          plan_id: row.planId,
          plan_digest: row.planDigest,
          approved_by: row.approvedByJson,
          attempt_seq: row.attemptSeq,
          result: row.result,
          code: row.code,
          job_id: row.jobId,
          receipt_id: row.receiptId,
          detail: row.detailJson,
          prev_hash: row.prevHash,
          hash: row.hash,
        })
        .onConflict((conflict) => conflict.doNothing())
        .executeTakeFirst();
      return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
    },

    async window(afterSeq, limit) {
      const rows = await db
        .selectFrom('audit_events')
        .selectAll()
        .where('seq', '>', afterSeq)
        .orderBy('seq', 'asc')
        .limit(Math.max(1, Math.min(Math.trunc(limit), MAX_AUDIT_WINDOW)))
        .execute();
      return rows.map(toAuditRow);
    },
  };
}

function toReceipt(row: Selectable<ReceiptsTable>): ReceiptRecord {
  return {
    id: row.id as ReceiptId,
    actionId: row.action_id as ActionId,
    planId: row.plan_id as PlanId | null,
    planDigest: row.plan_digest,
    principalId: row.principal_id,
    onBehalfOfId: row.on_behalf_of_id,
    correlationId: row.correlation_id,
    env: row.env as EnvClass,
    risk: row.risk as Risk,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    result: row.result as ReceiptRecord['result'],
    code: row.code,
    jobId: row.job_id as JobId | null,
    auditSeq: row.audit_seq,
    detailJson: row.detail,
    createdAt: row.created_at,
  };
}

export function createReceiptRepository(
  db: Kysely<Database>,
): ReceiptRepository {
  return {
    async insert(record) {
      await db
        .insertInto('receipts')
        .values({
          id: record.id,
          action_id: record.actionId,
          plan_id: record.planId,
          plan_digest: record.planDigest,
          principal_id: record.principalId,
          on_behalf_of_id: record.onBehalfOfId,
          correlation_id: record.correlationId,
          env: record.env,
          risk: record.risk,
          started_at: record.startedAt,
          finished_at: record.finishedAt,
          result: record.result,
          code: record.code,
          job_id: record.jobId,
          audit_seq: record.auditSeq,
          detail: record.detailJson,
          created_at: record.createdAt,
        })
        .execute();
    },

    async get(id) {
      const row = await db
        .selectFrom('receipts')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row === undefined ? undefined : toReceipt(row);
    },

    async purgeBefore(cutoff, limit) {
      const result = await db
        .deleteFrom('receipts')
        .where('id', 'in', (qb) =>
          qb
            .selectFrom('receipts')
            .select('id')
            .where('created_at', '<', cutoff)
            .limit(limit),
        )
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}
