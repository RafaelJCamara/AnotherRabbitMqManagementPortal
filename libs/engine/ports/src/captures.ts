// The capture repository port (M1-09, MSG-10 core). svc-messages owns the policy: it seals bodies
// and headers, builds the redacted projection, applies quota and retention options and keeps the
// bounded ingest queue. This port only stores rows: it never sees a key or a plaintext body, only
// sealed bytes and the masked text that is meant to be searched. `persistence` implements it, in
// process or behind a worker thread; every method is async from day one (I-5) and nothing lists
// "all" (I-7): reads are windows.
import type { EnvClass } from '@app/contracts';

import type { Window } from './repos.ts';

/** Where the body of a message is: sealed in its row, in the blob tables, or not kept (too large). */
export type CaptureBodyState = 'inline' | 'blob' | 'omitted';

/** The most rows one window returns; a larger `limit` is clamped to it. */
export const CAPTURE_MAX_WINDOW = 500;
/** The most messages one `appendMessages` call takes (one transaction). */
export const CAPTURE_MAX_BATCH = 1000;

export interface NewCapture {
  readonly id: string;
  readonly ownerId: string;
  /** What produced it (`manual`, `peek`, `tap`, `import`): opaque to the store. */
  readonly kind: string;
  readonly label: string;
  /** JSON text naming where the messages came from (connection, vhost, queue). Bounded by the caller. */
  readonly target: string;
  /** `prod` (or unset, which the service turns into `prod`) never indexes bodies. */
  readonly envClass: EnvClass;
  /** False keeps bodies out of the index whatever the environment. */
  readonly indexBodies: boolean;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** What was lost or left out, counted so nothing is silent (I-13). */
export interface CaptureCounters {
  /** Messages stored. */
  readonly messages: number;
  /** Bytes the capture holds (sealed values, masked text), the unit of the quota. */
  readonly storedBytes: number;
  /** Refused because the ingest queue was full. */
  readonly droppedQueue: number;
  /** Refused because the owner's quota was used. */
  readonly droppedQuota: number;
  /** Refused because the capture reached its message limit. */
  readonly droppedLimit: number;
  /** Stored without a body (over the blob cap). */
  readonly omittedBodies: number;
}

export interface CaptureRecord extends NewCapture, CaptureCounters {}

/** A body larger than the inline limit: sealed chunks under the plaintext sha256. */
export interface NewMessageBlob {
  /** Lowercase hex sha256 of the plaintext body. */
  readonly ref: string;
  /** Plaintext bytes. */
  readonly size: number;
  /** Plaintext bytes in every chunk but the last. */
  readonly chunkBytes: number;
  /** Sealed chunks in order. Ignored (and not stored again) when the blob already exists. */
  readonly chunks: readonly Uint8Array[];
}

export interface NewMessage {
  /** A ULID: ids order messages in time and key the sealed values. */
  readonly id: string;
  readonly receivedAt: number;
  readonly exchange: string;
  readonly routingKey: string;
  /** The queue or stream it was read from; empty for an import. */
  readonly source: string;
  readonly contentType: string | null;
  readonly redelivered: boolean;
  /** Plaintext body bytes. */
  readonly size: number;
  /** Lowercase hex sha256 of the plaintext body. */
  readonly bodySha256: string;
  readonly bodyState: CaptureBodyState;
  /** The sealed body when `bodyState` is `inline`. */
  readonly bodySealed: Uint8Array | null;
  /** The blob when `bodyState` is `blob`. */
  readonly blob: NewMessageBlob | null;
  /** Sealed JSON: properties and headers. */
  readonly metaSealed: Uint8Array;
  /** Redacted metadata words for the index and the preview. */
  readonly metaText: string;
  /** Redacted body text (bounded by the service); null when the body is not indexed. */
  readonly bodyText: string | null;
}

export interface AppendBatch {
  readonly captureId: string;
  readonly ownerId: string;
  readonly messages: readonly NewMessage[];
}

/** The limits one append is checked against, inside its transaction. */
export interface AppendLimits {
  readonly ownerQuotaBytes: number;
  readonly captureMaxMessages: number;
}

export type AppendRejectReason =
  | 'capture-missing'
  | 'quota'
  | 'capture-limit'
  | 'duplicate';

export interface AppendResult {
  readonly stored: number;
  /** Bytes added to the capture (the quota unit). */
  readonly storedBytes: number;
  /** At most one entry per message of the batch. */
  readonly rejected: readonly {
    readonly id: string;
    readonly reason: AppendRejectReason;
  }[];
  /** Milliseconds the transaction took, measured next to the database (the 5 ms budget). */
  readonly txnMs: number;
}

export interface MessageQuery {
  readonly captureId: string;
  /** Words to find in the index. Operators and quotes are plain text. */
  readonly text?: string;
  readonly exchange?: string;
  readonly routingKey?: string;
  readonly source?: string;
  readonly contentType?: string;
  readonly redelivered?: boolean;
  readonly sizeMin?: number;
  readonly sizeMax?: number;
  /** Received at or after / before this time (epoch ms). */
  readonly from?: number;
  readonly to?: number;
  readonly order: 'asc' | 'desc';
  /** At most `CAPTURE_MAX_WINDOW`. */
  readonly limit: number;
  /** The `nextCursor` of the previous window. */
  readonly cursor?: string;
}

export interface MessageSummary {
  readonly id: string;
  readonly captureId: string;
  readonly receivedAt: number;
  readonly exchange: string;
  readonly routingKey: string;
  readonly source: string;
  readonly contentType: string | null;
  readonly redelivered: boolean;
  readonly size: number;
  readonly bodySha256: string;
  readonly bodyState: CaptureBodyState;
  readonly blobRef: string | null;
  /** True when the masked body text went into the index. */
  readonly bodyIndexed: boolean;
  /** The first characters of the masked body text, or null. */
  readonly preview: string | null;
}

export interface StoredMessage extends MessageSummary {
  readonly bodySealed: Uint8Array | null;
  readonly metaSealed: Uint8Array;
}

export interface BlobChunk {
  readonly index: number;
  readonly sealed: Uint8Array;
}

export interface BlobSlice {
  readonly size: number;
  readonly chunkBytes: number;
  readonly chunkCount: number;
  /** The chunks `from` (included) to `to` (excluded) that exist. */
  readonly chunks: readonly BlobChunk[];
}

/** What a loss is counted as on its capture. */
export interface CaptureLoss {
  readonly queue?: number;
  readonly quota?: number;
  readonly limit?: number;
  readonly omitted?: number;
}

export interface DeleteResult {
  readonly captures: number;
  readonly messages: number;
  readonly blobsRemoved: number;
  readonly bytesFreed: number;
}

export interface CaptureUsage {
  readonly captures: number;
  readonly storedBytes: number;
}

export interface CaptureRepository {
  /** Rejects when the id exists. */
  createCapture(capture: NewCapture): Promise<void>;
  /** A capture of another owner, or one being deleted, is undefined. */
  getCapture(ownerId: string, id: string): Promise<CaptureRecord | undefined>;
  /** The owner's captures, newest first, after `cursor`. */
  listCaptures(
    ownerId: string,
    query: { limit: number; cursor?: string },
  ): Promise<Window<CaptureRecord>>;
  /**
   * Stores the batch in one transaction, applying `limits`. Messages the limits refuse come back in
   * `rejected`, and the refusals are counted on the capture. At most `CAPTURE_MAX_BATCH` messages.
   */
  appendMessages(
    batch: AppendBatch,
    limits: AppendLimits,
  ): Promise<AppendResult>;
  /**
   * A window of the capture's messages. A text query needs the index: when the runtime has none,
   * it rejects with `CaptureSearchUnavailableError` rather than answering with nothing.
   */
  queryMessages(
    ownerId: string,
    query: MessageQuery,
  ): Promise<Window<MessageSummary>>;
  getMessage(
    ownerId: string,
    captureId: string,
    id: string,
  ): Promise<StoredMessage | undefined>;
  /**
   * Sealed chunks `from` to `to` of a blob the owner reaches through a message of one of their
   * captures; undefined for any other reader, so a hash alone opens nothing.
   */
  getBlobChunks(
    ownerId: string,
    ref: string,
    from: number,
    to: number,
  ): Promise<BlobSlice | undefined>;
  /** Adds to the capture's loss counters. A capture that is gone is ignored. */
  noteLoss(captureId: string, loss: CaptureLoss): Promise<void>;
  /** Deletes the capture with its messages, index entries and unshared blobs; false when not the owner's. */
  deleteCapture(ownerId: string, id: string): Promise<DeleteResult | undefined>;
  /** Deletes at most `limit` captures that expired at or before `now` (or are half deleted). */
  purgeExpired(now: number, limit: number): Promise<DeleteResult>;
  usage(ownerId: string): Promise<CaptureUsage>;
  /** False when the runtime has no full-text index. */
  searchAvailable(): Promise<boolean>;
}

/** A text query on a database without a full-text index. Maps to `urn:problem:capture-search-unavailable`. */
export class CaptureSearchUnavailableError extends Error {
  readonly code = 'CAPTURE_SEARCH_UNAVAILABLE';
  constructor() {
    super('This database has no full-text index; search by metadata instead.');
    this.name = 'CaptureSearchUnavailableError';
  }
}
