import type { SizeOf } from './size.ts';

/** Why items left a bounded collection without being consumed. */
export type DropReason =
  /** A ring evicted its oldest items to make room (drop-head). */
  | 'overflow'
  /** A queue refused a new item because it was full (the caller still holds the item). */
  | 'full'
  /** One item is larger than `maxBytes` and can never fit. */
  | 'oversized'
  /** The owner discarded the contents with `clear()`. */
  | 'cleared';

/** One accounting event: what a single call dropped. Reported before the call returns. */
export interface DropEvent {
  reason: DropReason;
  items: number;
  bytes: number;
}

export interface BoundedOptions<T> {
  /** At most this many items are held (I-6). */
  maxItems: number;
  /** At most this many bytes, as measured by `sizeOf`, are held (I-6). */
  maxBytes: number;
  /**
   * The size of an item in bytes. Defaults to the UTF-8 length of a string or the byte length of
   * binary data; any other item type must pass its own.
   */
  sizeOf?: SizeOf<T>;
  /** Called after every drop with the counts of that drop, so callers can surface it (I-13). */
  onDrop?: (event: DropEvent) => void;
}

/** The counters every bounded collection reports. */
export interface BoundedStats {
  items: number;
  bytes: number;
  /** Items dropped since creation, for any reason. */
  dropped: number;
  /** Bytes of the dropped items. */
  droppedBytes: number;
  maxItems: number;
  maxBytes: number;
}
