// The Kysely implementation of the plan and idempotency ports of @app/ports (M0-29). It stores
// rows and compares-and-sets them; the lifecycle policy (TTLs, approvals, digests, sealing) is the
// kernel's PlanStore.
import type { ActionId, EnvClass, PlanId, Risk } from '@app/contracts';
import type {
  IdempotencyRepository,
  PlanApprovalRecord,
  PlanRecord,
  PlanRepository,
  PlanState,
} from '@app/ports';
import type { Kysely, Selectable } from 'kysely';

import type { Database, PlansTable } from '../database';

const LIVE_STATES: PlanState[] = ['open', 'awaiting-approval', 'approved'];
const ACTIVE_STATES: PlanState[] = [...LIVE_STATES, 'executing'];
const FINISHED_STATES: PlanState[] = [
  'executed',
  'failed',
  'expired',
  'rejected',
];

function toRecord(row: Selectable<PlansTable>): PlanRecord {
  return {
    id: row.id as PlanId,
    actionId: row.action_id as ActionId,
    inputHash: row.input_hash,
    digest: row.digest,
    principalId: row.principal_id,
    onBehalfOfId: row.on_behalf_of_id,
    profileFingerprint: row.profile_fingerprint,
    env: row.env as EnvClass,
    risk: row.risk as Risk,
    state: row.state as PlanState,
    approvalsRequired: row.approvals_required,
    approvals: JSON.parse(row.approvals) as PlanApprovalRecord[],
    gatesJson: row.gates,
    warningsJson: row.warnings,
    previewJson: row.preview,
    consentsRequired: JSON.parse(row.consents_required) as string[],
    confirmationPhrase: row.confirmation_phrase,
    // pg returns a Buffer and node:sqlite a Uint8Array: hand out a plain Uint8Array either way.
    payload: row.payload === null ? null : Uint8Array.from(row.payload),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

export function createPlanRepository(db: Kysely<Database>): PlanRepository {
  return {
    async insert(record) {
      await db
        .insertInto('plans')
        .values({
          id: record.id,
          action_id: record.actionId,
          input_hash: record.inputHash,
          digest: record.digest,
          principal_id: record.principalId,
          on_behalf_of_id: record.onBehalfOfId,
          profile_fingerprint: record.profileFingerprint,
          env: record.env,
          risk: record.risk,
          state: record.state,
          approvals_required: record.approvalsRequired,
          approvals: JSON.stringify(record.approvals),
          gates: record.gatesJson,
          warnings: record.warningsJson,
          consents_required: JSON.stringify(record.consentsRequired),
          confirmation_phrase: record.confirmationPhrase,
          preview: record.previewJson,
          payload: record.payload,
          expires_at: record.expiresAt,
          created_at: record.createdAt,
          updated_at: record.updatedAt,
          version: record.version,
        })
        .execute();
    },

    async get(id) {
      const row = await db
        .selectFrom('plans')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row === undefined ? undefined : toRecord(row);
    },

    async update(id, expectedVersion, patch, now) {
      // The WHERE on version is the compare-and-set: a concurrent change leaves nothing to update.
      const row = await db
        .updateTable('plans')
        .set({
          updated_at: now,
          version: expectedVersion + 1,
          ...(patch.state === undefined ? {} : { state: patch.state }),
          ...(patch.approvals === undefined
            ? {}
            : { approvals: JSON.stringify(patch.approvals) }),
          ...(patch.payload === undefined ? {} : { payload: patch.payload }),
          ...(patch.expiresAt === undefined
            ? {}
            : { expires_at: patch.expiresAt }),
        })
        .where('id', '=', id)
        .where('version', '=', expectedVersion)
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? undefined : toRecord(row);
    },

    async countActive(principalId, now) {
      const row = await db
        .selectFrom('plans')
        .select((eb) => eb.fn.countAll<number | string>().as('total'))
        .where('principal_id', '=', principalId)
        .where('state', 'in', ACTIVE_STATES)
        .where('expires_at', '>', now)
        .executeTakeFirstOrThrow();
      return Number(row.total);
    },

    async expireDue(now, limit) {
      const result = await db
        .updateTable('plans')
        .set((eb) => ({
          state: 'expired',
          payload: null,
          updated_at: now,
          version: eb('version', '+', 1),
        }))
        .where('id', 'in', (qb) =>
          qb
            .selectFrom('plans')
            .select('id')
            .where('state', 'in', LIVE_STATES)
            .where('expires_at', '<=', now)
            .limit(limit),
        )
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },

    async purgeBefore(cutoff, limit) {
      const result = await db
        .deleteFrom('plans')
        .where('id', 'in', (qb) =>
          qb
            .selectFrom('plans')
            .select('id')
            .where('state', 'in', FINISHED_STATES)
            .where('updated_at', '<', cutoff)
            .limit(limit),
        )
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}

export function createIdempotencyRepository(
  db: Kysely<Database>,
): IdempotencyRepository {
  return {
    async claim(principalId, key, info) {
      const result = await db
        .insertInto('idempotency_keys')
        .values({
          principal_id: principalId,
          key,
          action_id: info.actionId,
          plan_id: info.planId,
          created_at: info.at,
        })
        .onConflict((conflict) =>
          conflict.columns(['principal_id', 'key']).doNothing(),
        )
        .executeTakeFirst();
      return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
    },

    async has(principalId, key) {
      const row = await db
        .selectFrom('idempotency_keys')
        .select('key')
        .where('principal_id', '=', principalId)
        .where('key', '=', key)
        .executeTakeFirst();
      return row !== undefined;
    },

    async purgeBefore(cutoff) {
      const result = await db
        .deleteFrom('idempotency_keys')
        .where('created_at', '<', cutoff)
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}
