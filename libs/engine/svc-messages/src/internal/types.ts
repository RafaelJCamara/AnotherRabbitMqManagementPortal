// The shapes of the capture store (M1-09). Records and the repository port are @app/ports'; these are
// what a caller of the store passes and gets back. Nothing here carries a key.
import type { EnvClass } from '@app/contracts';
import type {
  CaptureBodyState,
  CaptureCounters,
  DeleteResult,
  MessageSummary,
} from '@app/ports';

export type JsonScalar = string | number | boolean | null;
export type JsonValue =
  | JsonScalar
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Volatile captures live in memory only; saved ones are sealed in the workspace database. */
export type CapturePersist = 'volatile' | 'saved';

export interface CaptureInput {
  /** What produced it (`manual`, `peek`, `tap`, `import`). A short word. */
  readonly kind: string;
  readonly label: string;
  /** Where the messages came from (connection, vhost, queue): JSON, no secrets. */
  readonly target: Readonly<Record<string, JsonValue>>;
  /** An unset environment class is `prod`: its bodies are never indexed (fail closed). */
  readonly envClass?: EnvClass;
  readonly persist: CapturePersist;
  /** False keeps bodies out of the index whatever the environment. Default true. */
  readonly indexBodies?: boolean;
  /** Overrides the store's retention for this capture. Saved captures only. */
  readonly retentionMs?: number;
}

export interface CapturedMessageInput {
  /** A ULID; the store mints one when absent. Saving the same id twice is a duplicate, not a copy. */
  readonly id?: string;
  readonly receivedAt: number;
  readonly exchange: string;
  readonly routingKey: string;
  /** The queue or stream it was read from. */
  readonly source?: string;
  readonly contentType?: string | null;
  readonly redelivered?: boolean;
  /** Message properties (message id, correlation id, type, app id...). Sealed whole. */
  readonly properties: Readonly<Record<string, JsonValue>>;
  /** Headers. Sealed whole; their values reach the index only outside `prod` and only if redacted. */
  readonly headers: Readonly<Record<string, JsonValue>>;
  readonly body: Uint8Array;
}

export interface AppendOptions {
  /**
   * Exact values known to be secrets (the connection's own login, a token the person pasted). They
   * are removed from the redacted projection in every encoding the canary scanner knows. Held for
   * this call only; never stored.
   */
  readonly secretValues?: readonly string[];
}

/** What `append` did. The messages it accepted are written by the ingest queue; see `flush()`. */
export interface AppendReceipt {
  readonly accepted: number;
  readonly refused: {
    /** The ingest queue was full (counted on the capture). */
    readonly queueFull: number;
    /** A single message was larger than the store takes at all. */
    readonly tooLarge: number;
    /** A message the store cannot represent (properties or headers that are not JSON). */
    readonly invalid: number;
    /** The vault refused to seal (locked) after some messages were taken. */
    readonly locked: number;
  };
}

export interface CaptureView extends CaptureCounters {
  readonly id: string;
  readonly ownerId: string;
  readonly kind: string;
  readonly label: string;
  readonly target: string;
  readonly envClass: EnvClass;
  readonly persist: CapturePersist;
  readonly indexBodies: boolean;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** Volatile only: messages pushed out of the ring (also counted in `droppedQueue`). */
  readonly evicted: number;
}

export interface CaptureQuery {
  readonly captureId: string;
  readonly text?: string;
  readonly exchange?: string;
  readonly routingKey?: string;
  readonly source?: string;
  readonly contentType?: string;
  readonly redelivered?: boolean;
  readonly sizeMin?: number;
  readonly sizeMax?: number;
  readonly from?: number;
  readonly to?: number;
  readonly order?: 'asc' | 'desc';
  readonly limit: number;
  readonly cursor?: string;
}

export type CapturedMessageView = MessageSummary;

export interface CapturedMessageDetail {
  readonly summary: MessageSummary;
  readonly properties: Readonly<Record<string, JsonValue>>;
  readonly headers: Readonly<Record<string, JsonValue>>;
  /**
   * The body, when it is kept and not larger than the `maxBodyBytes` asked for. Otherwise undefined,
   * and `summary.bodyState` says why (`blob` too large for this call: read it with `blob()`;
   * `omitted`: never kept).
   */
  readonly body: Uint8Array | undefined;
}

export interface SaveOptions {
  readonly secretValues?: readonly string[];
}

export interface SaveResult {
  readonly capture: CaptureView;
  readonly receipt: AppendReceipt;
}

/** Counters of the store since it started (I-13): what was taken, written, refused or lost. */
export interface CaptureStats {
  readonly queue: {
    readonly items: number;
    readonly bytes: number;
    readonly maxItems: number;
    readonly maxBytes: number;
  };
  readonly accepted: number;
  readonly stored: number;
  readonly rejected: {
    readonly quota: number;
    readonly captureLimit: number;
    readonly duplicate: number;
    readonly captureMissing: number;
  };
  readonly refused: {
    readonly queueFull: number;
    readonly tooLarge: number;
    readonly invalid: number;
    readonly locked: number;
  };
  /** Messages in a batch whose write failed (the repository threw): lost, and counted. */
  readonly lostToError: number;
  readonly omittedBodies: number;
  readonly batches: number;
  readonly lastTxnMs: number;
  readonly maxTxnMs: number;
  /** Messages per transaction now: it shrinks when a transaction is slow. */
  readonly batchSize: number;
  readonly volatileEvicted: number;
}

export type { CaptureBodyState, DeleteResult, MessageSummary };
