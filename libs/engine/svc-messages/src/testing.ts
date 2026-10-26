// Fakes for the ports of this module, shared by its specs, by the architecture manifest
// (tools/arch-tests) and by the HTTP specs (libs/testkit). Give each port in deps.ts a fake here.
//
// The capture fakes (M1-09) are a repository in memory and a sealer. The repository keeps the rules
// the service relies on (owner scoping, quota and message limits, duplicates, blob reference counts,
// all-words search) but not the real one's index; the real repository is proved against the same
// behaviour by `persistence`'s capture contract and, with this service on top, by the testkit's
// capture stack specs.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import {
  CAPTURE_MAX_WINDOW,
  CaptureSearchUnavailableError,
  type AppendBatch,
  type AppendLimits,
  type AppendRejectReason,
  type BlobSlice,
  type CaptureRecord,
  type CaptureRepository,
  type DeleteResult,
  type FieldSealer,
  type MessageQuery,
  type MessageSummary,
  type NewCapture,
  type NewMessage,
  type StoredMessage,
} from '@app/ports';

import { createLogger } from '@app/kernel';

import type {
  MessagesModuleDeps,
  PublishRecord,
  PublishRecorder,
} from './deps';
import type { CapturedMessageInput } from './internal/types';

export interface MemoryPublishRecorder extends PublishRecorder {
  /** What was recorded, in order. */
  readonly entries: readonly PublishRecord[];
  /** Makes the next `record` calls reject, `times` times, as a dead store would. */
  failNext(times: number, error?: unknown): void;
}

/** A recorder in memory. It numbers entries `history-1`, ... and keeps what it was handed. */
export function createMemoryPublishRecorder(): MemoryPublishRecorder {
  const entries: PublishRecord[] = [];
  let failures = 0;
  let failure: unknown = new Error('the history store is down');
  return {
    entries,
    failNext(times, error) {
      failures = times;
      if (error !== undefined) failure = error;
    },
    record(entry) {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(
          failure instanceof Error
            ? failure
            : new Error('the history store is down'),
        );
      }
      entries.push(entry);
      return Promise.resolve(`history-${String(entries.length)}`);
    },
  };
}

export function createMessagesFakeDeps(
  overrides: Partial<MessagesModuleDeps> = {},
): MessagesModuleDeps {
  return {
    recorder: createMemoryPublishRecorder(),
    logger: createLogger({ level: 'silent' }),
    ...overrides,
  };
}

export interface MemoryCaptureRepository extends CaptureRepository {
  /** Pretends the runtime has no full-text index. */
  disableSearch(): void;
  /** Makes the next `appendMessages` calls reject, `times` times. */
  failAppends(times: number): void;
  /** The transaction time the next appends report. */
  setTxnMs(ms: number): void;
  /** Every plain value the repository holds, as text, for leak checks. */
  dump(): string;
  /** The batch sizes of the appends so far. */
  readonly batches: readonly number[];
}

interface HeldCapture {
  record: NewCapture;
  counters: {
    messages: number;
    storedBytes: number;
    droppedQueue: number;
    droppedQuota: number;
    droppedLimit: number;
    omittedBodies: number;
  };
}

const words = (text: string): string[] =>
  (text.match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => w.toLowerCase());

export function createMemoryCaptureRepository(): MemoryCaptureRepository {
  const captures = new Map<string, HeldCapture>();
  const messages = new Map<
    string,
    { captureId: string; message: NewMessage }
  >();
  const blobs = new Map<
    string,
    { size: number; chunkBytes: number; chunks: Uint8Array[]; refcount: number }
  >();
  const batches: number[] = [];
  let searchOn = true;
  let failures = 0;
  let txnMs = 1;

  const record = (held: HeldCapture): CaptureRecord => ({
    ...held.record,
    ...held.counters,
  });
  const cost = (m: NewMessage): number =>
    256 +
    m.metaSealed.byteLength +
    (m.bodySealed?.byteLength ?? 0) +
    (m.blob?.chunks.reduce((sum, c) => sum + c.byteLength, 0) ?? 0) +
    Buffer.byteLength(m.metaText) +
    Buffer.byteLength(m.bodyText ?? '');
  const summary = (captureId: string, m: NewMessage): MessageSummary => ({
    id: m.id,
    captureId,
    receivedAt: m.receivedAt,
    exchange: m.exchange,
    routingKey: m.routingKey,
    source: m.source,
    contentType: m.contentType,
    redelivered: m.redelivered,
    size: m.size,
    bodySha256: m.bodySha256,
    bodyState: m.bodyState,
    blobRef: m.blob?.ref ?? null,
    bodyIndexed: m.bodyText !== null,
    preview: m.bodyText?.slice(0, 200) ?? null,
  });
  const ownerBytes = (ownerId: string): number =>
    [...captures.values()]
      .filter((c) => c.record.ownerId === ownerId)
      .reduce((sum, c) => sum + c.counters.storedBytes, 0);

  function removeCapture(id: string): DeleteResult {
    const held = captures.get(id);
    if (held === undefined) {
      return { captures: 0, messages: 0, blobsRemoved: 0, bytesFreed: 0 };
    }
    let removed = 0;
    let blobsRemoved = 0;
    for (const [messageId, entry] of [...messages]) {
      if (entry.captureId !== id) continue;
      messages.delete(messageId);
      removed += 1;
      const ref = entry.message.blob?.ref;
      const blob = ref === undefined ? undefined : blobs.get(ref);
      if (ref !== undefined && blob !== undefined) {
        blob.refcount -= 1;
        if (blob.refcount <= 0) {
          blobs.delete(ref);
          blobsRemoved += 1;
        }
      }
    }
    captures.delete(id);
    return {
      captures: 1,
      messages: removed,
      blobsRemoved,
      bytesFreed: held.counters.storedBytes,
    };
  }

  return {
    batches,
    disableSearch: () => {
      searchOn = false;
    },
    failAppends: (times) => {
      failures = times;
    },
    setTxnMs: (ms) => {
      txnMs = ms;
    },
    dump: () =>
      JSON.stringify([
        [...captures.values()].map((c) => c.record),
        [...messages.values()].map(({ message }) => ({
          ...message,
          bodySealed: null,
          metaSealed: null,
          blob: null,
        })),
      ]),

    createCapture(capture) {
      if (captures.has(capture.id)) {
        return Promise.reject(new Error('the capture exists'));
      }
      captures.set(capture.id, {
        record: capture,
        counters: {
          messages: 0,
          storedBytes: 0,
          droppedQueue: 0,
          droppedQuota: 0,
          droppedLimit: 0,
          omittedBodies: 0,
        },
      });
      return Promise.resolve();
    },

    getCapture(ownerId, id) {
      const held = captures.get(id);
      return Promise.resolve(
        held?.record.ownerId === ownerId ? record(held) : undefined,
      );
    },

    listCaptures(ownerId, query) {
      const all = [...captures.values()]
        .filter((c) => c.record.ownerId === ownerId)
        .map(record)
        .sort((a, b) => (a.id < b.id ? 1 : -1))
        .filter((c) => query.cursor === undefined || c.id < query.cursor);
      const limit = Math.min(Math.max(query.limit, 1), CAPTURE_MAX_WINDOW);
      const items = all.slice(0, limit);
      const last = items.at(-1);
      return Promise.resolve(
        all.length > limit && last !== undefined
          ? { items, nextCursor: last.id }
          : { items },
      );
    },

    appendMessages(batch: AppendBatch, limits: AppendLimits) {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error('the write failed'));
      }
      batches.push(batch.messages.length);
      const held = captures.get(batch.captureId);
      if (held?.record.ownerId !== batch.ownerId) {
        return Promise.resolve({
          stored: 0,
          storedBytes: 0,
          rejected: batch.messages.map((m) => ({
            id: m.id,
            reason: 'capture-missing' as const,
          })),
          txnMs,
        });
      }
      const rejected: { id: string; reason: AppendRejectReason }[] = [];
      let stored = 0;
      let storedBytes = 0;
      let total = ownerBytes(batch.ownerId);
      for (const m of batch.messages) {
        const c = cost(m);
        if (messages.has(m.id)) {
          rejected.push({ id: m.id, reason: 'duplicate' });
        } else if (held.counters.messages >= limits.captureMaxMessages) {
          rejected.push({ id: m.id, reason: 'capture-limit' });
          held.counters.droppedLimit += 1;
        } else if (total + c > limits.ownerQuotaBytes) {
          rejected.push({ id: m.id, reason: 'quota' });
          held.counters.droppedQuota += 1;
        } else {
          messages.set(m.id, { captureId: batch.captureId, message: m });
          if (m.blob !== null) {
            const blob = blobs.get(m.blob.ref);
            if (blob === undefined) {
              blobs.set(m.blob.ref, {
                size: m.blob.size,
                chunkBytes: m.blob.chunkBytes,
                chunks: [...m.blob.chunks],
                refcount: 1,
              });
            } else {
              blob.refcount += 1;
            }
          }
          if (m.bodyState === 'omitted') held.counters.omittedBodies += 1;
          held.counters.messages += 1;
          held.counters.storedBytes += c;
          total += c;
          stored += 1;
          storedBytes += c;
        }
      }
      return Promise.resolve({ stored, storedBytes, rejected, txnMs });
    },

    queryMessages(ownerId, query: MessageQuery) {
      const held = captures.get(query.captureId);
      if (held?.record.ownerId !== ownerId)
        return Promise.resolve({ items: [] });
      const wantsText = query.text !== undefined && query.text.trim() !== '';
      if (wantsText && !searchOn) {
        return Promise.reject(new CaptureSearchUnavailableError());
      }
      const terms = wantsText ? words(query.text ?? '') : [];
      if (wantsText && terms.length === 0)
        return Promise.resolve({ items: [] });
      const limit = Math.min(
        Math.max(Math.trunc(query.limit), 1),
        CAPTURE_MAX_WINDOW,
      );
      const rows = [...messages.values()]
        .filter((e) => e.captureId === query.captureId)
        .map((e) => e.message)
        .filter(
          (m) =>
            (query.exchange === undefined || m.exchange === query.exchange) &&
            (query.routingKey === undefined ||
              m.routingKey === query.routingKey) &&
            (query.source === undefined || m.source === query.source) &&
            (query.contentType === undefined ||
              m.contentType === query.contentType) &&
            (query.redelivered === undefined ||
              m.redelivered === query.redelivered) &&
            (query.sizeMin === undefined || m.size >= query.sizeMin) &&
            (query.sizeMax === undefined || m.size <= query.sizeMax) &&
            (query.from === undefined || m.receivedAt >= query.from) &&
            (query.to === undefined || m.receivedAt < query.to) &&
            (terms.length === 0 ||
              terms.every((t) =>
                words(`${m.metaText} ${m.bodyText ?? ''}`).includes(t),
              )),
        )
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      if (query.order === 'desc') rows.reverse();
      const after = rows.filter(
        (m) =>
          query.cursor === undefined ||
          (query.order === 'asc' ? m.id > query.cursor : m.id < query.cursor),
      );
      const items = after
        .slice(0, limit)
        .map((m) => summary(query.captureId, m));
      const last = items.at(-1);
      return Promise.resolve(
        after.length > limit && last !== undefined
          ? { items, nextCursor: last.id }
          : { items },
      );
    },

    getMessage(ownerId, captureId, id): Promise<StoredMessage | undefined> {
      const entry = messages.get(id);
      const held = captures.get(captureId);
      if (entry?.captureId !== captureId || held?.record.ownerId !== ownerId) {
        return Promise.resolve(undefined);
      }
      return Promise.resolve({
        ...summary(captureId, entry.message),
        bodySealed: entry.message.bodySealed,
        metaSealed: entry.message.metaSealed,
      });
    },

    getBlobChunks(ownerId, ref, from, to): Promise<BlobSlice | undefined> {
      const reachable = [...messages.values()].some(
        (e) =>
          e.message.blob?.ref === ref &&
          captures.get(e.captureId)?.record.ownerId === ownerId,
      );
      const blob = blobs.get(ref);
      if (!reachable || blob === undefined) return Promise.resolve(undefined);
      return Promise.resolve({
        size: blob.size,
        chunkBytes: blob.chunkBytes,
        chunkCount: blob.chunks.length,
        chunks: blob.chunks
          .map((sealed, index) => ({ index, sealed }))
          .filter((c) => c.index >= from && c.index < to),
      });
    },

    noteLoss(captureId, loss) {
      const held = captures.get(captureId);
      if (held !== undefined) {
        held.counters.droppedQueue += loss.queue ?? 0;
        held.counters.droppedQuota += loss.quota ?? 0;
        held.counters.droppedLimit += loss.limit ?? 0;
        held.counters.omittedBodies += loss.omitted ?? 0;
      }
      return Promise.resolve();
    },

    deleteCapture(ownerId, id) {
      return Promise.resolve(
        captures.get(id)?.record.ownerId === ownerId
          ? removeCapture(id)
          : undefined,
      );
    },

    purgeExpired(at, limit) {
      const due = [...captures.values()]
        .filter((c) => c.record.expiresAt <= at)
        .slice(0, limit);
      const total = {
        captures: 0,
        messages: 0,
        blobsRemoved: 0,
        bytesFreed: 0,
      };
      for (const c of due) {
        const step = removeCapture(c.record.id);
        total.captures += step.captures;
        total.messages += step.messages;
        total.blobsRemoved += step.blobsRemoved;
        total.bytesFreed += step.bytesFreed;
      }
      return Promise.resolve(total);
    },

    usage(ownerId) {
      const mine = [...captures.values()].filter(
        (c) => c.record.ownerId === ownerId,
      );
      return Promise.resolve({
        captures: mine.length,
        storedBytes: mine.reduce((sum, c) => sum + c.counters.storedBytes, 0),
      });
    },

    searchAvailable: () => Promise.resolve(searchOn),
  };
}

export interface FakeSealer extends FieldSealer {
  lock(): void;
  unlock(): void;
  /** Every value sealed so far, as stored (for tamper tests). */
  readonly sealedCount: () => number;
}

/**
 * A sealer with the properties of `@app/secrets`' field cipher: AES-256-GCM, a fresh nonce per
 * seal, the place a value lives in authenticated. The key is random and lives for this object.
 * `lock()` makes it refuse, like a locked vault.
 */
export function createFakeSealer(): FakeSealer {
  const key = randomBytes(32);
  let locked = false;
  let count = 0;
  const aad = (table: string, column: string, rowId: string): Buffer =>
    Buffer.from(`${table}:${column}:${rowId}`, 'utf8');
  return {
    lock: () => {
      locked = true;
    },
    unlock: () => {
      locked = false;
    },
    sealedCount: () => count,
    seal(table, column, rowId, plaintext) {
      if (locked) return Promise.reject(new Error('locked'));
      count += 1;
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aad(table, column, rowId));
      const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Promise.resolve(
        new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), body])),
      );
    },
    open(table, column, rowId, sealed) {
      if (locked) return Promise.reject(new Error('locked'));
      try {
        const buffer = Buffer.from(sealed);
        const decipher = createDecipheriv(
          'aes-256-gcm',
          key,
          buffer.subarray(0, 12),
        );
        decipher.setAAD(aad(table, column, rowId));
        decipher.setAuthTag(buffer.subarray(12, 28));
        return Promise.resolve(
          new Uint8Array(
            Buffer.concat([
              decipher.update(buffer.subarray(28)),
              decipher.final(),
            ]),
          ),
        );
      } catch {
        return Promise.reject(new Error('does not decrypt'));
      }
    },
  };
}

/** A message for specs: `n` gives it an id-ordered time, a routing key and a short JSON body. */
export function sampleMessage(
  n: number,
  over: Partial<CapturedMessageInput> = {},
): CapturedMessageInput {
  return {
    id: `01TESTMSG${String(n).padStart(8, '0')}`,
    receivedAt: 1_000_000 + n,
    exchange: n % 2 === 0 ? 'orders' : 'billing',
    routingKey: n % 3 === 0 ? 'orders.created' : 'orders.shipped',
    source: 'orders-queue',
    contentType: 'application/json',
    redelivered: n % 5 === 0,
    properties: {
      messageId: `m-${String(n)}`,
      correlationId: `c-${String(n)}`,
    },
    headers: { 'x-tenant': 'acme' },
    body: new TextEncoder().encode(
      JSON.stringify({ n, city: n % 2 === 0 ? 'London' : 'Paris' }),
    ),
    ...over,
  };
}
