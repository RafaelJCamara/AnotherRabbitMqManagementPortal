// The client's ring of one series (M1-54, R2, I-6, I-13): bounded by points and by bytes (two `float64` per
// point), time strictly ascending, and every point it does not keep counted. A full ring evicts the oldest point
// (`evicted`); a point that is not finite, or not newer than the newest, is not stored (`stale`).
export interface RingPoint {
  readonly t: number;
  readonly v: number;
}

/** At most this many points per series: the engine's hot window is one hour at 15 s and up, at most 720 points. */
export const RING_MAX_POINTS = 1000;
/** Two `float64` per point. */
export const BYTES_PER_POINT = 16;
export const RING_MAX_BYTES = RING_MAX_POINTS * BYTES_PER_POINT;

export interface RingOptions {
  readonly maxPoints?: number;
  readonly maxBytes?: number;
}

export interface RingStats {
  /** Every point offered. */
  readonly pushed: number;
  /** Oldest points pushed out by newer ones when the ring was full. */
  readonly evicted: number;
  /** Points not stored: not finite, or not newer than the newest point. */
  readonly stale: number;
}

export class SeriesRing {
  readonly capacity: number;
  readonly #times: Float64Array;
  readonly #values: Float64Array;
  #head = 0;
  #size = 0;
  #pushed = 0;
  #evicted = 0;
  #stale = 0;

  constructor(options: RingOptions = {}) {
    const byCount = Math.floor(options.maxPoints ?? RING_MAX_POINTS);
    const byBytes = Math.floor(
      (options.maxBytes ?? RING_MAX_BYTES) / BYTES_PER_POINT,
    );
    this.capacity = Math.max(1, Math.min(byCount, byBytes));
    this.#times = new Float64Array(this.capacity);
    this.#values = new Float64Array(this.capacity);
  }

  get length(): number {
    return this.#size;
  }

  /** The bytes of the points held; never above `capacity * BYTES_PER_POINT`. */
  get bytes(): number {
    return this.#size * BYTES_PER_POINT;
  }

  get stats(): RingStats {
    return {
      pushed: this.#pushed,
      evicted: this.#evicted,
      stale: this.#stale,
    };
  }

  /** The newest point, or `undefined`. */
  last(): RingPoint | undefined {
    if (this.#size === 0) return undefined;
    const at = (this.#head + this.#size - 1) % this.capacity;
    return { t: this.#times[at] ?? NaN, v: this.#values[at] ?? NaN };
  }

  push(t: number, v: number): 'kept' | 'stale' {
    this.#pushed += 1;
    const newest = this.last();
    if (
      !Number.isFinite(t) ||
      !Number.isFinite(v) ||
      (newest !== undefined && t <= newest.t)
    ) {
      this.#stale += 1;
      return 'stale';
    }
    if (this.#size === this.capacity) {
      this.#head = (this.#head + 1) % this.capacity;
      this.#size -= 1;
      this.#evicted += 1;
    }
    const at = (this.#head + this.#size) % this.capacity;
    this.#times[at] = t;
    this.#values[at] = v;
    this.#size += 1;
    return 'kept';
  }

  /** The points, oldest first. */
  points(): RingPoint[] {
    const out: RingPoint[] = [];
    for (let i = 0; i < this.#size; i++) {
      const at = (this.#head + i) % this.capacity;
      out.push({ t: this.#times[at] ?? NaN, v: this.#values[at] ?? NaN });
    }
    return out;
  }

  /**
   * Empties the ring to be filled again (a history read replaces what it holds). The points cleared are taken
   * back out of `pushed`, so `pushed = length + evicted + stale` still holds; the drops are never forgotten.
   */
  clear(): void {
    this.#pushed -= this.#size;
    this.#head = 0;
    this.#size = 0;
  }
}
