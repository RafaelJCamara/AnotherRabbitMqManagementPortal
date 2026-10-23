// The Kysely implementation of the CaptureRepository port of @app/ports (M1-09), for SQLite and
// Postgres. It stores rows and applies the limits it is given; sealing, the redacted projection,
// retention options and the ingest queue are svc-messages'. It never sees a key or a plaintext body.
//
// Index: SQLite keeps a contentless FTS5 table whose rowid is the message's rowid (absent when the
// runtime has no FTS5: `searchAvailable()` says so and a text query is refused, never answered with
// nothing). Postgres keeps a `search` tsvector column. Both are written in the transaction of the
// message and removed with it.
//
// Deleting: a capture is marked `deleting`, its messages go in batches of `DELETE_BATCH` (one
// transaction each, so the writer is never held for long), then the capture row goes. On SQLite the
// deletes run with `secure_delete` and the index is optimised afterwards, because a deleted index
// entry otherwise stays in its segment until the next merge.
import {
  CAPTURE_MAX_BATCH,
  CAPTURE_MAX_WINDOW,
  CaptureSearchUnavailableError,
  type AppendBatch,
  type AppendLimits,
  type AppendRejectReason,
  type AppendResult,
  type BlobSlice,
  type CaptureBodyState,
  type CaptureLoss,
  type CaptureRecord,
  type CaptureRepository,
  type DeleteResult,
  type MessageQuery,
  type MessageSummary,
  type NewCapture,
  type NewMessage,
  type StoredMessage,
  type Window,
} from '@app/ports';
import { sql, type Kysely, type Selectable } from 'kysely';

import type {
  CapturedMessagesTable,
  CapturesTable,
  Database,
} from '../database';
import type { DialectName } from '../migrate/helpers';
import { searchTerms, toFtsMatch, toTsQuery } from './capture-search';

/** Rows of a capture removed per transaction. */
const DELETE_BATCH = 400;
/** Rows inserted by one statement (SQLite binds at most 32,766 values; a row binds 16). */
const INSERT_GROUP = 100;
/** The longest preview of a masked body text. */
const PREVIEW_CHARS = 200;
/** The most chunks one blob read returns. */
const MAX_CHUNKS_PER_READ = 256;
/** Fixed cost of a message row in the quota unit (keys, indexes, fixed columns). */
const ROW_OVERHEAD_BYTES = 256;

type CaptureRow = Selectable<CapturesTable>;

function toCapture(row: CaptureRow): CaptureRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    kind: row.kind,
    label: row.label,
    target: row.target,
    envClass: row.env_class as CaptureRecord['envClass'],
    indexBodies: row.index_bodies === 1,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    messages: row.message_count,
    storedBytes: row.stored_bytes,
    droppedQueue: row.dropped_queue,
    droppedQuota: row.dropped_quota,
    droppedLimit: row.dropped_limit,
    omittedBodies: row.omitted_bodies,
  };
}

interface SummaryRow {
  id: string;
  capture_id: string;
  received_at: number;
  exchange: string;
  routing_key: string;
  source: string;
  content_type: string | null;
  redelivered: number;
  size: number;
  body_sha256: string;
  body_state: CaptureBodyState;
  blob_ref: string | null;
  indexed: number;
  preview: string | null;
}

function toSummary(row: SummaryRow): MessageSummary {
  return {
    id: row.id,
    captureId: row.capture_id,
    receivedAt: row.received_at,
    exchange: row.exchange,
    routingKey: row.routing_key,
    source: row.source,
    contentType: row.content_type,
    redelivered: row.redelivered === 1,
    size: row.size,
    bodySha256: row.body_sha256,
    bodyState: row.body_state,
    blobRef: row.blob_ref,
    bodyIndexed: row.indexed === 1,
    preview: row.preview,
  };
}

/** Bytes a message adds to its capture: the unit of the quota. */
export function storedBytesOf(message: NewMessage): number {
  const text = (value: string | null): number =>
    value === null ? 0 : Buffer.byteLength(value, 'utf8');
  return (
    ROW_OVERHEAD_BYTES +
    message.metaSealed.byteLength +
    (message.bodySealed?.byteLength ?? 0) +
    (message.blob?.chunks.reduce((sum, c) => sum + c.byteLength, 0) ?? 0) +
    text(message.metaText) +
    text(message.bodyText)
  );
}

function groups<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

export function createCaptureRepository(
  db: Kysely<Database>,
  dialect: DialectName,
  now: () => number,
): CaptureRepository {
  const isSqlite = dialect === 'sqlite';

  /** True when a full-text index exists in this database. */
  async function hasIndex(executor: Kysely<Database>): Promise<boolean> {
    if (!isSqlite) return true;
    const row = await sql<{
      n: number;
    }>`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'captured_fts'`.execute(
      executor,
    );
    return (row.rows[0]?.n ?? 0) > 0;
  }

  async function indexMessages(
    trx: Kysely<Database>,
    ids: readonly string[],
  ): Promise<void> {
    if (ids.length === 0) return;
    if (!isSqlite) {
      await sql`UPDATE captured_messages SET search = to_tsvector('simple', meta_text || ' ' || coalesce(body_text, '')) WHERE id IN (${sql.join(ids)})`.execute(
        trx,
      );
      return;
    }
    if (!(await hasIndex(trx))) return;
    await sql`INSERT INTO captured_fts (rowid, meta, body) SELECT rowid, meta_text, coalesce(body_text, '') FROM captured_messages WHERE id IN (${sql.join(ids)})`.execute(
      trx,
    );
  }

  async function ownerBytes(
    executor: Kysely<Database>,
    ownerId: string,
  ): Promise<number> {
    const row = await executor
      .selectFrom('captures')
      .select((eb) => eb.fn.sum<number | string>('stored_bytes').as('total'))
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    return Number(row?.total ?? 0);
  }

  async function appendInTransaction(
    trx: Kysely<Database>,
    batch: AppendBatch,
    limits: AppendLimits,
  ): Promise<Omit<AppendResult, 'txnMs'>> {
    const rejected: { id: string; reason: AppendRejectReason }[] = [];
    const capture = await trx
      .selectFrom('captures')
      .select(['id', 'message_count'])
      .where('id', '=', batch.captureId)
      .where('owner_id', '=', batch.ownerId)
      .where('deleting', '=', 0)
      .executeTakeFirst();
    if (capture === undefined) {
      return {
        stored: 0,
        storedBytes: 0,
        rejected: batch.messages.map((m) => ({
          id: m.id,
          reason: 'capture-missing' as const,
        })),
      };
    }

    const known = new Set(
      (
        await trx
          .selectFrom('captured_messages')
          .select('id')
          .where(
            'id',
            'in',
            batch.messages.map((m) => m.id),
          )
          .execute()
      ).map((r) => r.id),
    );
    let ownerTotal = await ownerBytes(trx, batch.ownerId);
    let held = capture.message_count;
    let added = 0;
    let droppedQuota = 0;
    let droppedLimit = 0;
    const accepted: NewMessage[] = [];
    for (const message of batch.messages) {
      const cost = storedBytesOf(message);
      if (known.has(message.id)) {
        rejected.push({ id: message.id, reason: 'duplicate' });
      } else if (held >= limits.captureMaxMessages) {
        rejected.push({ id: message.id, reason: 'capture-limit' });
        droppedLimit += 1;
      } else if (ownerTotal + cost > limits.ownerQuotaBytes) {
        rejected.push({ id: message.id, reason: 'quota' });
        droppedQuota += 1;
      } else {
        known.add(message.id);
        accepted.push(message);
        held += 1;
        ownerTotal += cost;
        added += cost;
      }
    }

    // Blobs: new ones are stored once, every message that uses one adds a reference.
    const wanted = new Map<string, NewMessage['blob']>();
    const uses = new Map<string, number>();
    for (const message of accepted) {
      if (message.blob === null) continue;
      if (!wanted.has(message.blob.ref))
        wanted.set(message.blob.ref, message.blob);
      uses.set(message.blob.ref, (uses.get(message.blob.ref) ?? 0) + 1);
    }
    if (wanted.size > 0) {
      const present = new Set(
        (
          await trx
            .selectFrom('capture_blobs')
            .select('ref')
            .where('ref', 'in', [...wanted.keys()])
            .execute()
        ).map((r) => r.ref),
      );
      for (const [ref, blob] of wanted) {
        if (blob === null || present.has(ref)) continue;
        await trx
          .insertInto('capture_blobs')
          .values({
            ref,
            size: blob.size,
            chunk_bytes: blob.chunkBytes,
            chunk_count: blob.chunks.length,
            refcount: 0,
            created_at: now(),
          })
          .execute();
        for (const [ix, sealed] of blob.chunks.entries()) {
          await trx
            .insertInto('capture_blob_chunks')
            .values({ ref, ix, sealed })
            .execute();
        }
      }
      for (const [ref, count] of uses) {
        await trx
          .updateTable('capture_blobs')
          .set((eb) => ({ refcount: eb('refcount', '+', count) }))
          .where('ref', '=', ref)
          .execute();
      }
    }

    for (const group of groups(accepted, INSERT_GROUP)) {
      await trx
        .insertInto('captured_messages')
        .values(
          group.map((m) => ({
            id: m.id,
            capture_id: batch.captureId,
            received_at: m.receivedAt,
            exchange: m.exchange,
            routing_key: m.routingKey,
            source: m.source,
            content_type: m.contentType,
            redelivered: m.redelivered ? 1 : 0,
            size: m.size,
            body_sha256: m.bodySha256,
            body_state: m.bodyState,
            body_sealed: m.bodySealed,
            blob_ref: m.blob?.ref ?? null,
            meta_sealed: m.metaSealed,
            meta_text: m.metaText,
            body_text: m.bodyText,
          })),
        )
        .execute();
      await indexMessages(
        trx,
        group.map((m) => m.id),
      );
    }

    const omitted = accepted.filter((m) => m.bodyState === 'omitted').length;
    await trx
      .updateTable('captures')
      .set((eb) => ({
        message_count: eb('message_count', '+', accepted.length),
        stored_bytes: eb('stored_bytes', '+', added),
        dropped_quota: eb('dropped_quota', '+', droppedQuota),
        dropped_limit: eb('dropped_limit', '+', droppedLimit),
        omitted_bodies: eb('omitted_bodies', '+', omitted),
      }))
      .where('id', '=', batch.captureId)
      .execute();
    return { stored: accepted.length, storedBytes: added, rejected };
  }

  /** One batch of a capture's messages out of the index, the blob references and the table. */
  async function deleteBatch(
    captureId: string,
  ): Promise<{ messages: number; blobsRemoved: number }> {
    return db.transaction().execute(async (trx) => {
      const rows = await sql<{
        id: string;
        blob_ref: string | null;
        rid: number;
      }>`SELECT id, blob_ref, ${isSqlite ? sql.raw('rowid') : sql.raw('0')} AS rid FROM captured_messages WHERE capture_id = ${captureId} ORDER BY id LIMIT ${DELETE_BATCH}`
        .execute(trx)
        .then((r) => r.rows);
      if (rows.length === 0) return { messages: 0, blobsRemoved: 0 };
      if (isSqlite && (await hasIndex(trx))) {
        await sql`DELETE FROM captured_fts WHERE rowid IN (${sql.join(rows.map((r) => r.rid))})`.execute(
          trx,
        );
      }
      await trx
        .deleteFrom('captured_messages')
        .where(
          'id',
          'in',
          rows.map((r) => r.id),
        )
        .execute();
      const refs = new Map<string, number>();
      for (const row of rows) {
        if (row.blob_ref !== null)
          refs.set(row.blob_ref, (refs.get(row.blob_ref) ?? 0) + 1);
      }
      let blobsRemoved = 0;
      for (const [ref, count] of refs) {
        const left = await trx
          .updateTable('capture_blobs')
          .set((eb) => ({ refcount: eb('refcount', '-', count) }))
          .where('ref', '=', ref)
          .returning('refcount')
          .executeTakeFirst();
        if (left !== undefined && left.refcount <= 0) {
          await trx
            .deleteFrom('capture_blob_chunks')
            .where('ref', '=', ref)
            .execute();
          await trx
            .deleteFrom('capture_blobs')
            .where('ref', '=', ref)
            .execute();
          blobsRemoved += 1;
        }
      }
      return { messages: rows.length, blobsRemoved };
    });
  }

  async function removeCapture(id: string): Promise<DeleteResult> {
    if (isSqlite) await sql`PRAGMA secure_delete = ON`.execute(db);
    const head = await db
      .updateTable('captures')
      .set({ deleting: 1 })
      .where('id', '=', id)
      .returning('stored_bytes')
      .executeTakeFirst();
    if (head === undefined) {
      return { captures: 0, messages: 0, blobsRemoved: 0, bytesFreed: 0 };
    }
    let messages = 0;
    let blobsRemoved = 0;
    for (;;) {
      const step = await deleteBatch(id);
      if (step.messages === 0) break;
      messages += step.messages;
      blobsRemoved += step.blobsRemoved;
    }
    await db.deleteFrom('captures').where('id', '=', id).execute();
    if (isSqlite && messages > 0 && (await hasIndex(db))) {
      await sql`INSERT INTO captured_fts (captured_fts) VALUES ('optimize')`.execute(
        db,
      );
    }
    return {
      captures: 1,
      messages,
      blobsRemoved,
      bytesFreed: head.stored_bytes,
    };
  }

  return {
    async createCapture(capture: NewCapture) {
      await db
        .insertInto('captures')
        .values({
          id: capture.id,
          owner_id: capture.ownerId,
          kind: capture.kind,
          label: capture.label,
          target: capture.target,
          env_class: capture.envClass,
          index_bodies: capture.indexBodies ? 1 : 0,
          created_at: capture.createdAt,
          expires_at: capture.expiresAt,
          message_count: 0,
          stored_bytes: 0,
          dropped_queue: 0,
          dropped_quota: 0,
          dropped_limit: 0,
          omitted_bodies: 0,
          deleting: 0,
        })
        .execute();
    },

    async getCapture(ownerId, id) {
      const row = await db
        .selectFrom('captures')
        .selectAll()
        .where('id', '=', id)
        .where('owner_id', '=', ownerId)
        .where('deleting', '=', 0)
        .executeTakeFirst();
      return row === undefined ? undefined : toCapture(row);
    },

    async listCaptures(ownerId, query): Promise<Window<CaptureRecord>> {
      const limit = Math.min(
        Math.max(Math.trunc(query.limit), 1),
        CAPTURE_MAX_WINDOW,
      );
      let select = db
        .selectFrom('captures')
        .selectAll()
        .where('owner_id', '=', ownerId)
        .where('deleting', '=', 0);
      if (query.cursor !== undefined)
        select = select.where('id', '<', query.cursor);
      const rows = await select
        .orderBy('id', 'desc')
        .limit(limit + 1)
        .execute();
      const page = rows.slice(0, limit).map(toCapture);
      const last = page.at(-1);
      return rows.length > limit && last !== undefined
        ? { items: page, nextCursor: last.id }
        : { items: page };
    },

    async appendMessages(batch, limits) {
      if (batch.messages.length > CAPTURE_MAX_BATCH) {
        throw new RangeError(
          `A capture batch holds at most ${String(CAPTURE_MAX_BATCH)} messages.`,
        );
      }
      if (batch.messages.length === 0) {
        return { stored: 0, storedBytes: 0, rejected: [], txnMs: 0 };
      }
      const started = performance.now();
      const result = await db
        .transaction()
        .execute((trx) => appendInTransaction(trx, batch, limits));
      return { ...result, txnMs: performance.now() - started };
    },

    async queryMessages(ownerId, query: MessageQuery) {
      const limit = Math.min(
        Math.max(Math.trunc(query.limit), 1),
        CAPTURE_MAX_WINDOW,
      );
      const terms = query.text === undefined ? [] : searchTerms(query.text);
      const wantsText = query.text !== undefined && query.text.trim() !== '';
      if (wantsText && !(await hasIndex(db)))
        throw new CaptureSearchUnavailableError();
      if (wantsText && terms.length === 0) return { items: [] };

      let select = db
        .selectFrom('captured_messages as m')
        .innerJoin('captures as c', 'c.id', 'm.capture_id')
        .select([
          'm.id',
          'm.capture_id',
          'm.received_at',
          'm.exchange',
          'm.routing_key',
          'm.source',
          'm.content_type',
          'm.redelivered',
          'm.size',
          'm.body_sha256',
          'm.body_state',
          'm.blob_ref',
          sql<number>`CASE WHEN m.body_text IS NULL THEN 0 ELSE 1 END`.as(
            'indexed',
          ),
          sql<string | null>`substr(m.body_text, 1, ${PREVIEW_CHARS})`.as(
            'preview',
          ),
        ])
        .where('c.owner_id', '=', ownerId)
        .where('c.id', '=', query.captureId)
        .where('c.deleting', '=', 0);
      if (query.exchange !== undefined)
        select = select.where('m.exchange', '=', query.exchange);
      if (query.routingKey !== undefined)
        select = select.where('m.routing_key', '=', query.routingKey);
      if (query.source !== undefined)
        select = select.where('m.source', '=', query.source);
      if (query.contentType !== undefined)
        select = select.where('m.content_type', '=', query.contentType);
      if (query.redelivered !== undefined)
        select = select.where('m.redelivered', '=', query.redelivered ? 1 : 0);
      if (query.sizeMin !== undefined)
        select = select.where('m.size', '>=', query.sizeMin);
      if (query.sizeMax !== undefined)
        select = select.where('m.size', '<=', query.sizeMax);
      if (query.from !== undefined)
        select = select.where('m.received_at', '>=', query.from);
      if (query.to !== undefined)
        select = select.where('m.received_at', '<', query.to);
      if (query.cursor !== undefined) {
        select = select.where(
          'm.id',
          query.order === 'asc' ? '>' : '<',
          query.cursor,
        );
      }
      if (terms.length > 0) {
        select = isSqlite
          ? select.where(
              sql<boolean>`m.rowid IN (SELECT rowid FROM captured_fts WHERE captured_fts MATCH ${toFtsMatch(terms)})`,
            )
          : select.where(
              sql<boolean>`m.search @@ to_tsquery('simple', ${toTsQuery(terms)})`,
            );
      }
      const rows = await select
        .orderBy('m.id', query.order)
        .limit(limit + 1)
        .execute();
      const page = rows.slice(0, limit).map((r) => toSummary(r));
      const last = page.at(-1);
      return rows.length > limit && last !== undefined
        ? { items: page, nextCursor: last.id }
        : { items: page };
    },

    async getMessage(
      ownerId,
      captureId,
      id,
    ): Promise<StoredMessage | undefined> {
      const row = await db
        .selectFrom('captured_messages as m')
        .innerJoin('captures as c', 'c.id', 'm.capture_id')
        .selectAll('m')
        .select(
          sql<string | null>`substr(m.body_text, 1, ${PREVIEW_CHARS})`.as(
            'preview',
          ),
        )
        .where('m.id', '=', id)
        .where('c.id', '=', captureId)
        .where('c.owner_id', '=', ownerId)
        .where('c.deleting', '=', 0)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      const message = row as Selectable<CapturedMessagesTable> & {
        preview: string | null;
      };
      return {
        ...toSummary({
          ...message,
          indexed: message.body_text === null ? 0 : 1,
        }),
        bodySealed:
          message.body_sealed === null
            ? null
            : Uint8Array.from(message.body_sealed),
        metaSealed: Uint8Array.from(message.meta_sealed),
      };
    },

    async getBlobChunks(
      ownerId,
      ref,
      from,
      to,
    ): Promise<BlobSlice | undefined> {
      const reachable = await db
        .selectFrom('captured_messages as m')
        .innerJoin('captures as c', 'c.id', 'm.capture_id')
        .select('m.id')
        .where('c.owner_id', '=', ownerId)
        .where('c.deleting', '=', 0)
        .where('m.blob_ref', '=', ref)
        .limit(1)
        .executeTakeFirst();
      if (reachable === undefined) return undefined;
      const blob = await db
        .selectFrom('capture_blobs')
        .selectAll()
        .where('ref', '=', ref)
        .executeTakeFirst();
      if (blob === undefined) return undefined;
      const first = Math.max(Math.trunc(from), 0);
      const end = Math.min(Math.trunc(to), first + MAX_CHUNKS_PER_READ);
      const chunks =
        end > first
          ? await db
              .selectFrom('capture_blob_chunks')
              .select(['ix', 'sealed'])
              .where('ref', '=', ref)
              .where('ix', '>=', first)
              .where('ix', '<', end)
              .orderBy('ix')
              .execute()
          : [];
      return {
        size: blob.size,
        chunkBytes: blob.chunk_bytes,
        chunkCount: blob.chunk_count,
        chunks: chunks.map((c) => ({
          index: c.ix,
          sealed: Uint8Array.from(c.sealed),
        })),
      };
    },

    async noteLoss(captureId, loss: CaptureLoss) {
      await db
        .updateTable('captures')
        .set((eb) => ({
          dropped_queue: eb('dropped_queue', '+', loss.queue ?? 0),
          dropped_quota: eb('dropped_quota', '+', loss.quota ?? 0),
          dropped_limit: eb('dropped_limit', '+', loss.limit ?? 0),
          omitted_bodies: eb('omitted_bodies', '+', loss.omitted ?? 0),
        }))
        .where('id', '=', captureId)
        .execute();
    },

    async deleteCapture(ownerId, id) {
      const owned = await db
        .selectFrom('captures')
        .select('id')
        .where('id', '=', id)
        .where('owner_id', '=', ownerId)
        .executeTakeFirst();
      return owned === undefined ? undefined : removeCapture(id);
    },

    async purgeExpired(at, limit) {
      const due = await db
        .selectFrom('captures')
        .select('id')
        .where((eb) =>
          eb.or([eb('expires_at', '<=', at), eb('deleting', '=', 1)]),
        )
        .orderBy('expires_at')
        .limit(Math.min(Math.max(Math.trunc(limit), 1), 100))
        .execute();
      const total: DeleteResult = {
        captures: 0,
        messages: 0,
        blobsRemoved: 0,
        bytesFreed: 0,
      };
      let { captures, messages, blobsRemoved, bytesFreed } = total;
      for (const { id } of due) {
        const step = await removeCapture(id);
        captures += step.captures;
        messages += step.messages;
        blobsRemoved += step.blobsRemoved;
        bytesFreed += step.bytesFreed;
      }
      return { captures, messages, blobsRemoved, bytesFreed };
    },

    async usage(ownerId) {
      const row = await db
        .selectFrom('captures')
        .select((eb) => [
          eb.fn.countAll<number | string>().as('n'),
          eb.fn.sum<number | string>('stored_bytes').as('total'),
        ])
        .where('owner_id', '=', ownerId)
        .executeTakeFirst();
      return {
        captures: Number(row?.n ?? 0),
        storedBytes: Number(row?.total ?? 0),
      };
    },

    searchAvailable: () => hasIndex(db),
  };
}
