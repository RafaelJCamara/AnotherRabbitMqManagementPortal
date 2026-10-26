// The publish history (M1-19, PUB-02): what a person published, per owner and per connection, kept
// until `expiresAt`. The service seals the properties, the headers and the body (already masked)
// into `dataSealed` with the field sealer (ADR-014) and builds the plain columns; the repository
// stores the bytes as given and never opens them (I-10). Every read is bounded (I-6, I-7): a window
// is a keyset page of at most `PUBLISH_HISTORY_MAX_WINDOW` rows, newest first, and nothing lists "all".

/** The longest window one `window` call returns. */
export const PUBLISH_HISTORY_MAX_WINDOW = 200;

/** The most rows one `purgeExpired` call removes. */
export const PUBLISH_HISTORY_MAX_PURGE = 1000;

/** The largest sealed document `insert` accepts: a backstop, the service keeps its own smaller bounds. */
export const PUBLISH_HISTORY_MAX_SEALED_BYTES = 1_048_576;

export interface NewPublishHistory {
  readonly id: string;
  readonly ownerId: string;
  readonly connectionId: string;
  readonly vhost: string;
  /** When the publish ran (epoch ms). */
  readonly at: number;
  /** When the row stops being returned and may be purged (epoch ms); expired when `<= now`. */
  readonly expiresAt: number;
  readonly exchange: string;
  readonly routingKey: string;
  readonly copies: number;
  /** JSON of the per-outcome counts: counts only, never a value. */
  readonly summary: string;
  readonly bodyBytes: number;
  readonly bodySha256: string;
  /** One sealed JSON document: masked properties, headers and body (ADR-014). */
  readonly dataSealed: Uint8Array;
}

/** A row without its sealed document: what a window returns. */
export interface PublishHistoryHead {
  readonly id: string;
  readonly ownerId: string;
  readonly connectionId: string;
  readonly vhost: string;
  readonly at: number;
  readonly expiresAt: number;
  readonly exchange: string;
  readonly routingKey: string;
  readonly copies: number;
  readonly summary: string;
  readonly bodyBytes: number;
  readonly bodySha256: string;
}

/** A row with its sealed document: what `get` returns. */
export interface PublishHistoryRow extends PublishHistoryHead {
  readonly dataSealed: Uint8Array;
}

export interface PublishHistoryQuery {
  /** Required: a history is read one connection at a time. */
  readonly connectionId: string;
  /** Rows with `expiresAt <= now` are never returned, whether or not they were purged. */
  readonly now: number;
  readonly vhost?: string;
  readonly exchange?: string;
  /** Exact, case-sensitive prefix of the routing key; the empty string matches all. */
  readonly routingKeyPrefix?: string;
  /** At or after / at or before this time (epoch ms). */
  readonly from?: number;
  readonly to?: number;
  /** An integer from 1 to `PUBLISH_HISTORY_MAX_WINDOW`; anything else rejects with a `RangeError`. */
  readonly limit: number;
  /** The `nextCursor` of the previous window; a value that is not one rejects with a `RangeError`. */
  readonly cursor?: string;
}

export interface PublishHistoryRepository {
  /** Rejects when the id exists or the sealed document is over `PUBLISH_HISTORY_MAX_SEALED_BYTES`. */
  insert(row: NewPublishHistory): Promise<void>;
  /** The owner's rows on one connection, ordered by `(at, id)` descending, without their sealed documents. */
  window(
    ownerId: string,
    query: PublishHistoryQuery,
  ): Promise<{
    readonly rows: readonly PublishHistoryHead[];
    readonly nextCursor?: string;
  }>;
  /** Undefined for an unknown id, another owner's row and another connection's row alike. Expiry is the caller's to check. */
  get(
    ownerId: string,
    connectionId: string,
    id: string,
  ): Promise<PublishHistoryRow | undefined>;
  /** Deletes at most `limit` (1 to `PUBLISH_HISTORY_MAX_PURGE`) rows with `expiresAt <= now`, oldest first. Returns how many. */
  purgeExpired(now: number, limit: number): Promise<number>;
}
