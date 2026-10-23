// The capture store (M1-09, MSG-10 core): the engine-side home of messages a person saves into the
// local workspace. Later work packages (peek, tap, import, export) pass messages in through
// `append` and read them through `query`, `get` and `blob`; there is no broker I/O here and no action
// (any action that stores or reads captures touches messages, so it goes through the ActionExecutor,
// I-2, and names the owner from its principal).
//
// What this file decides:
//   sealing    bodies, headers and properties are AES-GCM sealed through the vault's field cipher
//              before they leave this process's memory for the repository; a locked vault stores
//              nothing (there is no plaintext fallback);
//   projection the only text that is indexed is the redacted projection of ./projection;
//   bounds     one ingest queue bounded by items and bytes, one transaction per batch within a time
//              budget, windows of at most 500, every refusal counted (I-6, I-7, I-13);
//   volatile   captures that never touch the database until the person saves them.
import type { EnvClass } from '@app/contracts';
import { AppError, type Logger } from '@app/kernel';
import {
  CAPTURE_MAX_WINDOW,
  CaptureSearchUnavailableError,
  type AppendLimits,
  type CaptureRecord,
  type CaptureRepository,
  type DeleteResult,
  type FieldSealer,
  type NewMessage,
  type Window,
} from '@app/ports';

import { createIngest, type Ingest } from './ingest';
import { buildProjection } from './projection';
import {
  BLOB_MAX_BYTES,
  CHUNK_BYTES,
  createCaptureSealer,
  INLINE_MAX_BYTES,
  sha256Hex,
  yieldToLoop,
  type CaptureSealer,
} from './seal';
import type {
  AppendOptions,
  AppendReceipt,
  CaptureInput,
  CapturePersist,
  CaptureQuery,
  CaptureStats,
  CaptureView,
  CapturedMessageDetail,
  CapturedMessageInput,
  CapturedMessageView,
  SaveOptions,
  SaveResult,
} from './types';
import {
  createVolatileCapture,
  queryVolatile,
  summaryOf,
  type VolatileCapture,
  type VolatileMessage,
} from './volatile';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CaptureStoreOptions {
  /** How long a saved capture is kept. Blueprint 6.3: 7 days on desktop and local. */
  readonly retentionMs: number;
  /** The most stored bytes one owner holds in saved captures. Blueprint 6.3: 1 GiB. */
  readonly ownerQuotaBytes: number;
  readonly captureMaxMessages: number;
  readonly maxCapturesPerOwner: number;
  readonly queueMaxItems: number;
  readonly queueMaxBytes: number;
  /** The transaction time a batch should stay within (blueprint 1.4: 5 ms). */
  readonly budgetMs: number;
  readonly maxBatch: number;
  readonly volatileMaxMessages: number;
  readonly volatileMaxBytes: number;
  readonly volatileMaxCaptures: number;
  /** A message with a larger body is refused whole (counted on its capture). */
  readonly maxMessageBytes: number;
}

export const DEFAULT_CAPTURE_STORE_OPTIONS: CaptureStoreOptions = {
  retentionMs: 7 * DAY_MS,
  ownerQuotaBytes: 1024 * 1024 * 1024,
  captureMaxMessages: 100_000,
  maxCapturesPerOwner: 200,
  queueMaxItems: 4096,
  queueMaxBytes: 64 * 1024 * 1024,
  budgetMs: 5,
  maxBatch: 200,
  volatileMaxMessages: 5000,
  volatileMaxBytes: 32 * 1024 * 1024,
  volatileMaxCaptures: 64,
  maxMessageBytes: 128 * 1024 * 1024,
};

export interface CaptureStoreDeps {
  readonly repo: CaptureRepository;
  /** The vault's field cipher (`@app/secrets`' `FieldCipher` has this shape). */
  readonly sealer: FieldSealer;
  /** A ULID source: ids order messages in time and key the sealed values. */
  readonly newId: () => string;
  readonly now?: () => number;
  readonly logger?: Logger;
  readonly options?: Partial<CaptureStoreOptions>;
}

export interface CaptureStore {
  create(ownerId: string, input: CaptureInput): Promise<CaptureView>;
  /** One capture of the owner, saved or volatile; undefined when it is not theirs. */
  capture(ownerId: string, id: string): Promise<CaptureView | undefined>;
  /** The owner's saved captures, newest first. */
  list(
    ownerId: string,
    query: { limit: number; cursor?: string },
  ): Promise<Window<CaptureView>>;
  /** The owner's volatile captures (at most `volatileMaxCaptures`). */
  volatile(ownerId: string): readonly CaptureView[];
  append(
    ownerId: string,
    captureId: string,
    messages: readonly CapturedMessageInput[],
    options?: AppendOptions,
  ): Promise<AppendReceipt>;
  query(
    ownerId: string,
    query: CaptureQuery,
  ): Promise<Window<CapturedMessageView>>;
  get(
    ownerId: string,
    captureId: string,
    id: string,
    options?: { maxBodyBytes?: number },
  ): Promise<CapturedMessageDetail | undefined>;
  /** `length` bytes of a saved body from `offset` (at most 4 MiB per call). */
  blob(
    ownerId: string,
    ref: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array>;
  /** Writes a volatile capture to a new saved capture; a second call adds only what is new. */
  save(
    ownerId: string,
    volatileId: string,
    options?: SaveOptions,
  ): Promise<SaveResult>;
  remove(ownerId: string, id: string): Promise<DeleteResult | undefined>;
  /** Deletes at most `limit` expired captures (saved and volatile). */
  purgeExpired(limit?: number): Promise<DeleteResult>;
  /** Resolves when every accepted message is written or counted as lost. */
  flush(): Promise<void>;
  stats(): CaptureStats;
  close(): Promise<void>;
}

/** The most bytes `blob()` returns in one call. */
export const MAX_BLOB_READ_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const MAX_META_BYTES = 256 * 1024;
const MAX_LABEL_CHARS = 200;
const MAX_TARGET_BYTES = 4096;
const KIND = /^[a-z][a-z0-9-]{0,31}$/;
const MESSAGE_ID = /^[0-9A-Za-z_-]{8,64}$/;
/** Messages sealed before the loop gets a turn. */
const SLICE_MS = 3;
/** Messages per slice when a volatile capture is saved. */
const SAVE_SLICE = 100;
const ROW_OVERHEAD = 256;

const notFound = (): AppError =>
  new AppError('NOT_FOUND', { detail: 'There is no such capture.' });

const invalid = (detail: string): AppError =>
  new AppError('VALIDATION_FAILED', { detail });

const emptyRefusals = (): {
  queueFull: number;
  tooLarge: number;
  invalid: number;
  locked: number;
} => ({ queueFull: 0, tooLarge: 0, invalid: 0, locked: 0 });

function toView(record: CaptureRecord): CaptureView {
  return { ...record, persist: 'saved', evicted: 0 };
}

export function createCaptureStore(deps: CaptureStoreDeps): CaptureStore {
  const options: CaptureStoreOptions = {
    ...DEFAULT_CAPTURE_STORE_OPTIONS,
    ...deps.options,
  };
  const now = deps.now ?? Date.now;
  const { repo } = deps;
  const sealer: CaptureSealer = createCaptureSealer(deps.sealer);
  const limits: AppendLimits = {
    ownerQuotaBytes: options.ownerQuotaBytes,
    captureMaxMessages: options.captureMaxMessages,
  };
  const ingest: Ingest = createIngest({
    repo,
    limits: () => limits,
    maxItems: options.queueMaxItems,
    maxBytes: options.queueMaxBytes,
    budgetMs: options.budgetMs,
    maxBatch: options.maxBatch,
    onError: (code) => {
      deps.logger?.warn({ code }, 'a capture batch could not be written');
    },
  });
  const volatiles = new Map<string, VolatileCapture>();
  const totals = {
    accepted: 0,
    omittedBodies: 0,
    refused: emptyRefusals(),
    volatileEvicted: 0,
  };
  let closed = false;

  function ownVolatile(
    ownerId: string,
    id: string,
  ): VolatileCapture | undefined {
    const found = volatiles.get(id);
    return found?.view.ownerId === ownerId ? found : undefined;
  }

  function volatileView(capture: VolatileCapture): CaptureView {
    return {
      ...capture.view,
      messages: capture.ring.size,
      storedBytes: capture.ring.bytes,
      droppedQueue: capture.evicted,
      evicted: capture.evicted,
    };
  }

  function assertOpen(): void {
    if (closed) {
      throw new AppError('ENGINE_SHUTTING_DOWN', {
        detail: 'The capture store is closed.',
      });
    }
  }

  /** The row of one message: sealed parts, hashes and the redacted projection. */
  async function prepare(
    message: CapturedMessageInput,
    view: { envClass: EnvClass; indexBodies: boolean },
    secrets: readonly string[],
  ): Promise<NewMessage> {
    const id = message.id ?? deps.newId();
    const body = message.body;
    const size = body.byteLength;
    const sha = await sha256Hex(body);
    const meta = await sealer.sealMeta(id, {
      properties: message.properties,
      headers: message.headers,
    });
    let bodyState: NewMessage['bodyState'] = 'omitted';
    let bodySealed: Uint8Array | null = null;
    let blob: NewMessage['blob'] = null;
    if (size <= INLINE_MAX_BYTES) {
      bodyState = 'inline';
      bodySealed = await sealer.sealBody(id, body);
    } else if (size <= BLOB_MAX_BYTES) {
      bodyState = 'blob';
      blob = {
        ref: sha,
        size,
        chunkBytes: CHUNK_BYTES,
        chunks: await sealer.sealChunks(sha, body),
      };
    }
    const projection = buildProjection(
      {
        envClass: view.envClass,
        indexBodies: view.indexBodies,
        exchange: message.exchange,
        routingKey: message.routingKey,
        source: message.source ?? '',
        contentType: message.contentType ?? null,
        properties: message.properties,
        headers: message.headers,
        body,
      },
      secrets,
    );
    return {
      id,
      receivedAt: message.receivedAt,
      exchange: message.exchange,
      routingKey: message.routingKey,
      source: message.source ?? '',
      contentType: message.contentType ?? null,
      redelivered: message.redelivered ?? false,
      size,
      bodySha256: sha,
      bodyState,
      bodySealed,
      blob,
      metaSealed: meta,
      metaText: projection.metaText,
      bodyText: projection.bodyText,
    };
  }

  function queueBytes(message: NewMessage): number {
    const text = (value: string | null): number =>
      value === null ? 0 : Buffer.byteLength(value, 'utf8');
    return (
      ROW_OVERHEAD +
      message.metaSealed.byteLength +
      (message.bodySealed?.byteLength ?? 0) +
      (message.blob?.chunks.reduce((sum, c) => sum + c.byteLength, 0) ?? 0) +
      text(message.metaText) +
      text(message.bodyText)
    );
  }

  /** True for a message the store can represent: bounded, JSON properties and headers, a usable id. */
  function representable(message: CapturedMessageInput): boolean {
    if (message.id !== undefined && !MESSAGE_ID.test(message.id)) return false;
    try {
      const meta = JSON.stringify({
        properties: message.properties,
        headers: message.headers,
      });
      return Buffer.byteLength(meta, 'utf8') <= MAX_META_BYTES;
    } catch {
      return false;
    }
  }

  async function appendSaved(
    ownerId: string,
    capture: CaptureRecord,
    messages: readonly CapturedMessageInput[],
    secrets: readonly string[],
  ): Promise<AppendReceipt> {
    const refused = emptyRefusals();
    let accepted = 0;
    let sliceStart = performance.now();
    for (const [index, message] of messages.entries()) {
      if (message.body.byteLength > options.maxMessageBytes) {
        refused.tooLarge += 1;
        continue;
      }
      if (!representable(message)) {
        refused.invalid += 1;
        continue;
      }
      if (
        !ingest.hasRoom(
          Math.min(message.body.byteLength, INLINE_MAX_BYTES) + 2048,
        )
      ) {
        refused.queueFull += messages.length - index;
        break;
      }
      let row: NewMessage;
      try {
        row = await prepare(message, capture, secrets);
      } catch (error) {
        if (accepted === 0 && refused.locked === 0) throw error;
        // The vault locked part way: what was taken stays taken, the rest is refused and said so.
        refused.locked += messages.length - index;
        break;
      }
      if (
        !ingest.offer({
          captureId: capture.id,
          ownerId,
          message: row,
          bytes: queueBytes(row),
        })
      ) {
        refused.queueFull += 1;
        continue;
      }
      accepted += 1;
      if (row.bodyState === 'omitted') totals.omittedBodies += 1;
      if (performance.now() - sliceStart > SLICE_MS) {
        await yieldToLoop();
        sliceStart = performance.now();
      }
    }
    ingest.refused(capture.id, refused.queueFull, 'queue');
    ingest.refused(capture.id, refused.tooLarge, 'limit');
    totals.accepted += accepted;
    totals.refused.queueFull += refused.queueFull;
    totals.refused.tooLarge += refused.tooLarge;
    totals.refused.invalid += refused.invalid;
    totals.refused.locked += refused.locked;
    return { accepted, refused };
  }

  async function appendVolatile(
    capture: VolatileCapture,
    messages: readonly CapturedMessageInput[],
    secrets: readonly string[],
  ): Promise<AppendReceipt> {
    const refused = emptyRefusals();
    let accepted = 0;
    for (const message of messages) {
      if (!representable(message)) {
        refused.invalid += 1;
        continue;
      }
      const id = message.id ?? deps.newId();
      const input: CapturedMessageInput = { ...message, id };
      const projection = buildProjection(
        {
          envClass: capture.view.envClass,
          indexBodies: capture.view.indexBodies,
          exchange: message.exchange,
          routingKey: message.routingKey,
          source: message.source ?? '',
          contentType: message.contentType ?? null,
          properties: message.properties,
          headers: message.headers,
          body: message.body,
        },
        secrets,
      );
      const entry: VolatileMessage = {
        id,
        input,
        sha256: await sha256Hex(message.body),
        metaText: projection.metaText,
        bodyText: projection.bodyText,
        bytes:
          ROW_OVERHEAD +
          message.body.byteLength +
          projection.metaText.length +
          (projection.bodyText?.length ?? 0) +
          JSON.stringify(message.headers).length,
      };
      // A ring never refuses: it makes room (counted as evicted) or, for one message larger than
      // the whole ring, drops that one (also counted).
      capture.ring.add(entry);
      accepted += 1;
    }
    totals.accepted += accepted;
    totals.refused.invalid += refused.invalid;
    return { accepted, refused };
  }

  async function savedCapture(
    ownerId: string,
    id: string,
  ): Promise<CaptureRecord> {
    const record = await repo.getCapture(ownerId, id);
    if (record === undefined) throw notFound();
    return record;
  }

  const store: CaptureStore = {
    async create(ownerId, input) {
      assertOpen();
      if (!KIND.test(input.kind))
        throw invalid('kind is a short lower-case word.');
      if (input.label.length === 0 || input.label.length > MAX_LABEL_CHARS) {
        throw invalid(`label is 1 to ${String(MAX_LABEL_CHARS)} characters.`);
      }
      const target = JSON.stringify(input.target);
      if (Buffer.byteLength(target, 'utf8') > MAX_TARGET_BYTES) {
        throw invalid('target is too large.');
      }
      const envClass: EnvClass = input.envClass ?? 'prod';
      const indexBodies = (input.indexBodies ?? true) && envClass !== 'prod';
      const id = deps.newId();
      const createdAt = now();
      const persist: CapturePersist = input.persist;
      if (persist === 'volatile') {
        if (volatiles.size >= options.volatileMaxCaptures) {
          throw new AppError('BUDGET_EXCEEDED', {
            detail: 'Too many volatile captures are open; close one first.',
          });
        }
        const capture = createVolatileCapture(
          {
            id,
            ownerId,
            kind: input.kind,
            label: input.label,
            target,
            envClass,
            persist,
            indexBodies,
            createdAt,
            expiresAt: createdAt + (input.retentionMs ?? options.retentionMs),
            messages: 0,
            storedBytes: 0,
            droppedQueue: 0,
            droppedQuota: 0,
            droppedLimit: 0,
            omittedBodies: 0,
            evicted: 0,
          },
          {
            maxItems: options.volatileMaxMessages,
            maxBytes: options.volatileMaxBytes,
          },
        );
        volatiles.set(id, capture);
        return volatileView(capture);
      }
      const usage = await repo.usage(ownerId);
      if (usage.captures >= options.maxCapturesPerOwner) {
        throw new AppError('BUDGET_EXCEEDED', {
          detail: 'Too many saved captures; delete one first.',
        });
      }
      await repo.createCapture({
        id,
        ownerId,
        kind: input.kind,
        label: input.label,
        target,
        envClass,
        indexBodies,
        createdAt,
        expiresAt: createdAt + (input.retentionMs ?? options.retentionMs),
      });
      return toView(await savedCapture(ownerId, id));
    },

    async capture(ownerId, id) {
      const memory = ownVolatile(ownerId, id);
      if (memory !== undefined) return volatileView(memory);
      const record = await repo.getCapture(ownerId, id);
      return record === undefined ? undefined : toView(record);
    },

    async list(ownerId, query) {
      const window = await repo.listCaptures(ownerId, query);
      return {
        items: window.items.map(toView),
        ...(window.nextCursor === undefined
          ? {}
          : { nextCursor: window.nextCursor }),
      };
    },

    volatile: (ownerId) =>
      [...volatiles.values()]
        .filter((capture) => capture.view.ownerId === ownerId)
        .map(volatileView),

    async append(ownerId, captureId, messages, appendOptions = {}) {
      assertOpen();
      const secrets = appendOptions.secretValues ?? [];
      const memory = ownVolatile(ownerId, captureId);
      if (memory !== undefined)
        return appendVolatile(memory, messages, secrets);
      return appendSaved(
        ownerId,
        await savedCapture(ownerId, captureId),
        messages,
        secrets,
      );
    },

    async query(ownerId, query) {
      const memory = ownVolatile(ownerId, query.captureId);
      const repoQuery = { ...query, order: query.order ?? 'desc' } as const;
      if (memory !== undefined) {
        return queryVolatile(memory, repoQuery, CAPTURE_MAX_WINDOW);
      }
      try {
        return await repo.queryMessages(ownerId, repoQuery);
      } catch (error) {
        if (error instanceof CaptureSearchUnavailableError) {
          throw new AppError('CAPABILITY_MISSING', {
            detail:
              'This database has no full-text index, so words cannot be searched. Filter by exchange, routing key, size or time instead.',
            cause: error,
          });
        }
        throw error;
      }
    },

    async get(ownerId, captureId, id, getOptions = {}) {
      const maxBody = getOptions.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
      const memory = ownVolatile(ownerId, captureId);
      if (memory !== undefined) {
        const found = memory.ring.toArray().find((m) => m.id === id);
        if (found === undefined) return undefined;
        return {
          summary: summaryOf(captureId, found),
          properties: found.input.properties,
          headers: found.input.headers,
          body:
            found.input.body.byteLength <= maxBody
              ? found.input.body
              : undefined,
        };
      }
      const stored = await repo.getMessage(ownerId, captureId, id);
      if (stored === undefined) return undefined;
      const { bodySealed, metaSealed, ...summary } = stored;
      const meta = await sealer.openMeta(id, metaSealed);
      let body: Uint8Array | undefined;
      if (summary.bodyState === 'inline' && bodySealed !== null) {
        body =
          summary.size <= maxBody
            ? await sealer.openBody(id, bodySealed)
            : undefined;
      } else if (summary.bodyState === 'blob' && summary.blobRef !== null) {
        body =
          summary.size <= maxBody && summary.size <= MAX_BLOB_READ_BYTES
            ? await store.blob(ownerId, summary.blobRef, 0, summary.size)
            : undefined;
      }
      return {
        summary,
        properties: meta.properties,
        headers: meta.headers,
        body,
      };
    },

    async blob(ownerId, ref, offset, length) {
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length < 0
      ) {
        throw invalid(
          'offset and length are whole numbers of bytes, not negative.',
        );
      }
      const want = Math.min(length, MAX_BLOB_READ_BYTES);
      const first = Math.floor(offset / CHUNK_BYTES);
      const last = Math.ceil((offset + want) / CHUNK_BYTES);
      const slice = await repo.getBlobChunks(ownerId, ref, first, last);
      if (slice === undefined) throw notFound();
      if (slice.chunkBytes !== CHUNK_BYTES) {
        throw new AppError('INTERNAL', {
          detail: 'A saved body uses a chunk size this engine does not read.',
        });
      }
      const end = Math.min(offset + want, slice.size);
      if (offset >= slice.size || end <= offset) return new Uint8Array(0);
      const out = new Uint8Array(end - offset);
      for (const chunk of slice.chunks) {
        const plain = await sealer.openChunk(ref, chunk.index, chunk.sealed);
        const from = chunk.index * CHUNK_BYTES;
        const start = Math.max(offset, from);
        const stop = Math.min(end, from + plain.byteLength);
        if (stop > start)
          out.set(plain.subarray(start - from, stop - from), start - offset);
        plain.fill(0);
        await yieldToLoop();
      }
      return out;
    },

    async save(ownerId, volatileId, saveOptions = {}) {
      assertOpen();
      const memory = ownVolatile(ownerId, volatileId);
      if (memory === undefined) throw notFound();
      let target = memory.savedAs;
      if (target === undefined) {
        const parsed = JSON.parse(memory.view.target) as Record<string, never>;
        const created = await store.create(ownerId, {
          kind: memory.view.kind,
          label: memory.view.label,
          target: parsed,
          envClass: memory.view.envClass,
          persist: 'saved',
          indexBodies: memory.view.indexBodies,
        });
        target = created.id;
        memory.savedAs = target;
      }
      const receipt = { accepted: 0, refused: emptyRefusals() };
      const ordered = memory.ring
        .toArray()
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (let at = 0; at < ordered.length; at += SAVE_SLICE) {
        const slice = ordered.slice(at, at + SAVE_SLICE).map((m) => m.input);
        const step = await store.append(ownerId, target, slice, saveOptions);
        receipt.accepted += step.accepted;
        receipt.refused.queueFull += step.refused.queueFull;
        receipt.refused.tooLarge += step.refused.tooLarge;
        receipt.refused.invalid += step.refused.invalid;
        receipt.refused.locked += step.refused.locked;
        // One slice at a time: the queue never fills from a save.
        await ingest.flush();
      }
      const saved = await repo.getCapture(ownerId, target);
      if (saved === undefined) throw notFound();
      return { capture: toView(saved), receipt };
    },

    async remove(ownerId, id) {
      const memory = ownVolatile(ownerId, id);
      if (memory !== undefined) {
        const messages = memory.ring.size;
        volatiles.delete(id);
        return {
          captures: 1,
          messages,
          blobsRemoved: 0,
          bytesFreed: memory.ring.bytes,
        };
      }
      return repo.deleteCapture(ownerId, id);
    },

    async purgeExpired(limit = 20) {
      const at = now();
      let volatileRemoved = 0;
      for (const [id, capture] of [...volatiles]) {
        if (capture.view.expiresAt <= at) {
          volatiles.delete(id);
          volatileRemoved += 1;
        }
      }
      const result = await repo.purgeExpired(at, limit);
      deps.logger?.info(
        {
          captures: result.captures,
          messages: result.messages,
          volatileRemoved,
        },
        'expired captures purged',
      );
      return { ...result, captures: result.captures + volatileRemoved };
    },

    flush: () => ingest.flush(),

    stats() {
      const q = ingest.stats();
      let evicted = 0;
      for (const capture of volatiles.values()) evicted += capture.evicted;
      return {
        queue: {
          items: q.items,
          bytes: q.bytes,
          maxItems: q.maxItems,
          maxBytes: q.maxBytes,
        },
        accepted: totals.accepted,
        stored: q.stored,
        rejected: q.rejected,
        refused: { ...totals.refused },
        lostToError: q.lostToError,
        omittedBodies: totals.omittedBodies,
        batches: q.batches,
        lastTxnMs: q.lastTxnMs,
        maxTxnMs: q.maxTxnMs,
        batchSize: q.batchSize,
        volatileEvicted: evicted,
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      await ingest.flush();
    },
  };
  return store;
}
