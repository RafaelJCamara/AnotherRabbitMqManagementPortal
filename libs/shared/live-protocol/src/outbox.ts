// Per-subscription outboxes (blueprint 3.5), one per QoS. Each is bounded by items and by bytes
// (I-6) and has no I/O and no timers: `take(now)` is the only place time matters, and `now` is
// passed in, so a caller's clock (or a test) drives the maxHz cadence.
//
// Every item the producer offers gets the next `seq` (1, 2, ...). The invariant that makes loss
// visible (I-13): each seq is either carried by a frame, superseded by a newer value of the same
// key (`latest`), skipped on purpose (`sampled`, announced by `sampledEvery`), counted in
// `dropped`, or inside the range of a `gap` that is followed by a snapshot. Nothing else happens.
import type { Qos, ServerFrame } from '@app/contracts';

/** An item and its encoded size; the producer measures it, this library never serialises. */
export interface Sized<T> {
  readonly value: T;
  readonly bytes: number;
}

export interface OutboxBounds {
  readonly items: number;
  readonly bytes: number;
}

export type GapReason = Extract<ServerFrame, { t: 'gap' }>['reason'];

export interface Gap {
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly reason: GapReason;
}

/** What the next frame of a subscription carries. A snapshot is filled in by the session. */
export type Take<T> =
  | {
      readonly kind: 'data';
      readonly seq: number;
      readonly items: T[];
      readonly dropped?: number;
      readonly sampledEvery?: number;
    }
  | {
      readonly kind: 'delta';
      readonly seq: number;
      readonly upserts: T[];
      readonly removes: string[];
    }
  | {
      readonly kind: 'snapshot';
      readonly seq: number;
      /** Present when the snapshot replaces items that were not delivered. The gap goes first. */
      readonly gap?: Gap;
    };

export interface OutboxOptions {
  readonly bounds: OutboxBounds;
  /** No frame carries more item bytes than this (SessionLimits.maxFrameBytes). */
  readonly maxFrameBytes: number;
  readonly flow?: 'credit' | 'snapshot-delta';
  /** At most this many frames per second; unset means no pacing. */
  readonly maxHz?: number;
  /** `sampled` only: keep one item in every `sampleEvery` (default 1). */
  readonly sampleEvery?: number;
}

export interface Outbox<Q extends Qos = Qos, T = unknown> {
  readonly qos: Q;
  /** Items and bytes held, including lossless items kept for resume. */
  readonly items: number;
  readonly bytes: number;
  /** Seq of the newest item offered. */
  readonly lastSeq: number;
  /** Items lost to the bounds so far (all of them reported by a gap or by `dropped`). */
  readonly dropped: number;
  /**
   * Offers an item. `maxTotalBytes` caps what this outbox may hold after the push (the smaller of
   * its own bound and what is left of the session budget). `key` identifies the item for `latest`.
   */
  push(item: Sized<T>, key: string | undefined, maxTotalBytes: number): void;
  /** `snapshot-delta` only: the keyed item is gone. */
  remove(key: string, maxTotalBytes: number): void;
  /** The next frame, or null when nothing is pending or maxHz says to wait. */
  take(now: number): Take<T> | null;
  /** When `take` will produce something: `now` or later, or null when nothing is pending. */
  readyAt(now: number): number | null;
  /**
   * Makes the next frame a snapshot. With `from`, it is preceded by a gap that starts there.
   * Used by resume and by the initial snapshot of `snapshot-delta` topics.
   */
  resync(from?: { readonly fromSeq: number; readonly reason: GapReason }): void;
  /**
   * Lossless only: replays what a client missed. True when every item after `afterSeq` is still
   * held (or was never sent); false when some is gone and a gap plus snapshot is needed.
   */
  rewind(afterSeq: number): boolean;
}

interface Resync {
  readonly fromSeq: number | null;
  readonly reason: GapReason;
}

function assertBound(n: number, what: string): void {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(
      `${what} must be a positive integer, got ${String(n)}`,
    );
  }
}

abstract class OutboxBase<Q extends Qos, T> implements Outbox<Q, T> {
  abstract readonly qos: Q;
  protected readonly bounds: OutboxBounds;
  protected readonly maxFrameBytes: number;
  readonly #minIntervalMs: number;
  #resync: Resync | null = null;
  #lastTakeAt = Number.NEGATIVE_INFINITY;
  protected seq = 0;
  /** Highest seq the client has been given or told about (frame, or gap plus snapshot). */
  protected sent = 0;
  dropped = 0;

  constructor(options: OutboxOptions) {
    assertBound(options.bounds.items, 'outbox items');
    assertBound(options.bounds.bytes, 'outbox bytes');
    assertBound(options.maxFrameBytes, 'frame bytes');
    if (options.maxHz !== undefined && !(options.maxHz > 0)) {
      throw new RangeError('maxHz must be positive');
    }
    this.bounds = options.bounds;
    this.maxFrameBytes = options.maxFrameBytes;
    this.#minIntervalMs =
      options.maxHz === undefined ? 0 : 1000 / options.maxHz;
    if (options.flow === 'snapshot-delta') {
      this.#resync = { fromSeq: null, reason: 'overflow' };
    }
  }

  abstract get items(): number;
  abstract get bytes(): number;
  protected abstract pendingCount(): number;
  /** Forgets every held item. */
  protected abstract discard(): void;
  protected abstract accept(
    item: Sized<T>,
    maxTotalBytes: number,
    key: string | undefined,
  ): void;
  /** Only called while `pendingCount() > 0`. */
  protected abstract produce(): Take<T>;

  get lastSeq(): number {
    return this.seq;
  }

  push(item: Sized<T>, key: string | undefined, maxTotalBytes: number): void {
    if (this.offer()) return;
    this.accept(item, this.cap(maxTotalBytes), key);
  }

  abstract remove(key: string, maxTotalBytes: number): void;
  abstract rewind(afterSeq: number): boolean;

  /** Numbers an offered item. True when a pending resync absorbs it. */
  protected offer(): boolean {
    this.seq += 1;
    if (this.#resync === null) return false;
    // The snapshot that follows covers this item; the gap range does too.
    if (this.#resync.fromSeq !== null) this.dropped += 1;
    return true;
  }

  protected cap(maxTotalBytes: number): number {
    return Math.min(this.bounds.bytes, Math.max(0, maxTotalBytes));
  }

  take(now: number): Take<T> | null {
    const at = this.readyAt(now);
    if (at === null || at > now) return null;
    this.#lastTakeAt = now;
    const resync = this.#resync;
    if (resync === null) return this.produce();
    this.#resync = null;
    this.discard();
    const toSeq = this.seq;
    this.sent = toSeq;
    return resync.fromSeq === null
      ? { kind: 'snapshot', seq: toSeq }
      : {
          kind: 'snapshot',
          seq: toSeq,
          gap: { fromSeq: resync.fromSeq, toSeq, reason: resync.reason },
        };
  }

  readyAt(now: number): number | null {
    if (this.#resync === null && this.pendingCount() === 0) return null;
    return Math.max(now, this.#lastTakeAt + this.#minIntervalMs);
  }

  resync(from?: {
    readonly fromSeq: number;
    readonly reason: GapReason;
  }): void {
    this.discard();
    const current = this.#resync;
    if (from === undefined) {
      this.#resync ??= { fromSeq: null, reason: 'overflow' };
    } else if (current?.fromSeq == null || from.fromSeq < current.fromSeq) {
      this.#resync = { fromSeq: from.fromSeq, reason: from.reason };
    }
  }

  /** The bounds were hit and the items cannot be kept: a gap, then a snapshot. */
  protected overflow(lost: number): void {
    this.dropped += lost;
    this.discard();
    this.#resync ??= { fromSeq: this.sent + 1, reason: 'overflow' };
  }
}

interface Entry<T> {
  readonly seq: number;
  readonly value: T;
  readonly bytes: number;
}

/** Number of leading entries that fit one frame (at least one). */
function frameCount<T>(
  entries: readonly Entry<T>[],
  from: number,
  maxFrameBytes: number,
): number {
  let bytes = 0;
  let n = 0;
  for (let i = from; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === undefined || (n > 0 && bytes + entry.bytes > maxFrameBytes)) {
      break;
    }
    bytes += entry.bytes;
    n += 1;
  }
  return n;
}

/**
 * Never drops. Sent entries stay (oldest evicted first) so a resumed client can be replayed; only
 * when the unsent entries alone do not fit does it overflow into a gap and a snapshot.
 */
export class LosslessOutbox<T> extends OutboxBase<'lossless', T> {
  readonly qos = 'lossless';
  #entries: Entry<T>[] = [];
  /** Entries before this index were sent. */
  #cursor = 0;
  #held = 0;

  get items(): number {
    return this.#entries.length;
  }
  get bytes(): number {
    return this.#held;
  }
  protected pendingCount(): number {
    return this.#entries.length - this.#cursor;
  }
  protected discard(): void {
    this.#entries = [];
    this.#cursor = 0;
    this.#held = 0;
  }

  protected accept(item: Sized<T>, maxTotalBytes: number): void {
    const fits = (): boolean =>
      this.#entries.length < this.bounds.items &&
      this.#held + item.bytes <= maxTotalBytes;
    while (item.bytes <= this.maxFrameBytes && !fits() && this.#cursor > 0) {
      const oldest = this.#entries.shift();
      this.#cursor -= 1;
      this.#held -= oldest?.bytes ?? 0;
    }
    if (item.bytes > this.maxFrameBytes || !fits()) {
      this.overflow(this.pendingCount() + 1);
      return;
    }
    this.#entries.push({ seq: this.seq, value: item.value, bytes: item.bytes });
    this.#held += item.bytes;
  }

  protected produce(): Take<T> {
    const n = frameCount(this.#entries, this.#cursor, this.maxFrameBytes);
    const taken = this.#entries.slice(this.#cursor, this.#cursor + n);
    this.#cursor += n;
    this.sent = taken.at(-1)?.seq ?? this.sent;
    return { kind: 'data', seq: this.sent, items: taken.map((e) => e.value) };
  }

  remove(): void {
    throw new RangeError('lossless outboxes have no removals');
  }

  rewind(afterSeq: number): boolean {
    if (afterSeq > this.sent) return false;
    if (afterSeq === this.sent) return true;
    const first = this.#entries[0];
    if (first === undefined || first.seq > afterSeq + 1) return false;
    const index = this.#entries.findIndex((e) => e.seq > afterSeq);
    if (index < 0) return false;
    this.#cursor = index;
    // What the client has is what counts: a gap after a later overflow must start there.
    this.sent = afterSeq;
    return true;
  }
}

type Pending<T> =
  | {
      readonly removed: false;
      readonly seq: number;
      readonly bytes: number;
      readonly value: T;
    }
  | { readonly removed: true; readonly seq: number; readonly bytes: number };

/**
 * Coalesces by key: only the newest value per key is kept, in the order of its latest update, so
 * the frame cadence is the topic's maxHz and a slow client sees the newest state. For
 * `snapshot-delta` the frames are deltas and a bounds hit is an overflow (a gap, then a snapshot);
 * for `credit` flow the oldest key is dropped and counted in the next frame's `dropped`.
 */
export class LatestOutbox<T> extends OutboxBase<'latest', T> {
  readonly qos = 'latest';
  readonly #deltas: boolean;
  #pending = new Map<string, Pending<T>>();
  #held = 0;
  #droppedSinceFrame = 0;

  constructor(options: OutboxOptions) {
    super(options);
    this.#deltas = options.flow === 'snapshot-delta';
  }

  get items(): number {
    return this.#pending.size;
  }
  get bytes(): number {
    return this.#held;
  }
  protected pendingCount(): number {
    return this.#pending.size;
  }
  protected discard(): void {
    this.#pending = new Map();
    this.#held = 0;
  }

  protected accept(
    item: Sized<T>,
    maxTotalBytes: number,
    key: string | undefined,
  ): void {
    this.insert(
      key ?? '',
      { seq: this.seq, bytes: item.bytes, removed: false, value: item.value },
      maxTotalBytes,
    );
  }

  rewind(): boolean {
    return false;
  }

  remove(key: string, maxTotalBytes: number): void {
    if (!this.#deltas) {
      throw new RangeError('only snapshot-delta topics have removals');
    }
    if (this.offer()) return;
    // Key length is a UTF-8 upper bound (3 bytes per UTF-16 unit); a removal is never free.
    const bytes = Math.max(1, key.length * 3);
    this.insert(
      key,
      { seq: this.seq, bytes, removed: true },
      this.cap(maxTotalBytes),
    );
  }

  private insert(key: string, next: Pending<T>, maxTotalBytes: number): void {
    const previous = this.#pending.get(key);
    if (previous !== undefined) {
      this.#pending.delete(key);
      this.#held -= previous.bytes;
    }
    if (next.bytes > this.maxFrameBytes || next.bytes > maxTotalBytes) {
      this.reject();
      return;
    }
    while (
      this.#pending.size >= this.bounds.items ||
      this.#held + next.bytes > maxTotalBytes
    ) {
      if (this.#deltas) {
        this.overflow(this.#pending.size + 1);
        return;
      }
      const oldest = this.#pending.entries().next();
      if (oldest.done) break;
      this.#pending.delete(oldest.value[0]);
      this.#held -= oldest.value[1].bytes;
      this.dropped += 1;
      this.#droppedSinceFrame += 1;
    }
    this.#pending.set(key, next);
    this.#held += next.bytes;
  }

  /** An item that can never fit is lost: a gap for deltas, a counted drop otherwise. */
  private reject(): void {
    if (this.#deltas) {
      this.overflow(this.#pending.size + 1);
    } else {
      this.dropped += 1;
      this.#droppedSinceFrame += 1;
    }
  }

  protected produce(): Take<T> {
    const upserts: T[] = [];
    const removes: string[] = [];
    let bytes = 0;
    let seq = this.sent;
    for (const [key, p] of this.#pending) {
      const first = upserts.length + removes.length === 0;
      if (!first && bytes + p.bytes > this.maxFrameBytes) break;
      this.#pending.delete(key);
      bytes += p.bytes;
      seq = p.seq;
      if (p.removed) removes.push(key);
      else upserts.push(p.value);
    }
    this.#held -= bytes;
    this.sent = seq;
    if (this.#deltas) return { kind: 'delta', seq, upserts, removes };
    const dropped = this.#droppedSinceFrame;
    this.#droppedSinceFrame = 0;
    return dropped > 0
      ? { kind: 'data', seq, items: upserts, dropped }
      : { kind: 'data', seq, items: upserts };
  }
}

/**
 * Keeps every `sampleEvery`-th item, in order, and drops the oldest when full. Skipped items are
 * announced by `sampledEvery` on each frame, dropped ones by `dropped`.
 */
export class SampledOutbox<T> extends OutboxBase<'sampled', T> {
  readonly qos = 'sampled';
  readonly #every: number;
  #offered = 0;
  #entries: Entry<T>[] = [];
  #held = 0;
  #droppedSinceFrame = 0;

  constructor(options: OutboxOptions) {
    super(options);
    this.#every = options.sampleEvery ?? 1;
    assertBound(this.#every, 'sampleEvery');
  }

  get items(): number {
    return this.#entries.length;
  }
  get bytes(): number {
    return this.#held;
  }
  protected pendingCount(): number {
    return this.#entries.length;
  }
  protected discard(): void {
    this.#entries = [];
    this.#held = 0;
  }

  remove(): void {
    throw new RangeError('sampled outboxes have no removals');
  }

  rewind(): boolean {
    return false;
  }

  protected accept(item: Sized<T>, maxTotalBytes: number): void {
    const keep = this.#offered % this.#every === 0;
    this.#offered += 1;
    if (!keep) return;
    if (item.bytes > this.maxFrameBytes || item.bytes > maxTotalBytes) {
      this.lose(1);
      return;
    }
    while (
      this.#entries.length >= this.bounds.items ||
      this.#held + item.bytes > maxTotalBytes
    ) {
      const oldest = this.#entries.shift();
      if (oldest === undefined) break;
      this.#held -= oldest.bytes;
      this.lose(1);
    }
    this.#entries.push({ seq: this.seq, value: item.value, bytes: item.bytes });
    this.#held += item.bytes;
  }

  private lose(n: number): void {
    this.dropped += n;
    this.#droppedSinceFrame += n;
  }

  protected produce(): Take<T> {
    const n = frameCount(this.#entries, 0, this.maxFrameBytes);
    const taken = this.#entries.splice(0, n);
    this.#held -= taken.reduce((sum, e) => sum + e.bytes, 0);
    this.sent = taken.at(-1)?.seq ?? this.sent;
    const dropped = this.#droppedSinceFrame;
    this.#droppedSinceFrame = 0;
    return {
      kind: 'data',
      seq: this.sent,
      items: taken.map((e) => e.value),
      ...(dropped > 0 ? { dropped } : {}),
      ...(this.#every > 1 ? { sampledEvery: this.#every } : {}),
    };
  }
}

export function createOutbox<T>(
  qos: 'lossless',
  options: OutboxOptions,
): Outbox<'lossless', T>;
export function createOutbox<T>(
  qos: 'latest',
  options: OutboxOptions,
): Outbox<'latest', T>;
export function createOutbox<T>(
  qos: 'sampled',
  options: OutboxOptions,
): Outbox<'sampled', T>;
export function createOutbox<T>(
  qos: Qos,
  options: OutboxOptions,
): Outbox<Qos, T>;
export function createOutbox<T>(
  qos: Qos,
  options: OutboxOptions,
): Outbox<Qos, T> {
  switch (qos) {
    case 'lossless':
      return new LosslessOutbox<T>(options);
    case 'latest':
      return new LatestOutbox<T>(options);
    case 'sampled':
      return new SampledOutbox<T>(options);
  }
}
