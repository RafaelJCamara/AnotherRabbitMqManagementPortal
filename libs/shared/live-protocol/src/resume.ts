// Session resume (blueprint 3.5): a session survives transport loss for 30 s. While it waits, the
// hub keeps the session object in a `ResumeRegistry`; `hello{resume}` claims it back. Lossless
// topics continue from the client's `lastSeq` when the outbox still holds what it missed;
// everything else, and a lossless topic that lost items, gets a snapshot (with a gap when items
// were lost, so the loss is visible).
import type { Outbox } from './outbox.ts';

export const RESUME_WINDOW_MS = 30_000;
/** Parked sessions are bounded too (I-6); the oldest is evicted and counted. */
export const DEFAULT_MAX_PARKED = 256;

export interface ResumeRegistryStats {
  readonly parked: number;
  readonly claimed: number;
  /** Sessions whose window ran out before a `hello{resume}` claimed them. */
  readonly expired: number;
  /** Sessions pushed out because the registry was full. */
  readonly evicted: number;
}

export interface ResumeRegistryOptions<S = unknown> {
  readonly windowMs?: number;
  readonly maxParked?: number;
  /**
   * Called when a parked session is forgotten without being claimed (its window ran out, or the
   * registry was full), so its owner can release what it holds (the hub stops its topic sources).
   */
  readonly onDrop?: (
    id: string,
    session: S,
    reason: 'expired' | 'evicted',
  ) => void;
}

export class ResumeRegistry<S> {
  readonly #windowMs: number;
  readonly #maxParked: number;
  readonly #onDrop: ResumeRegistryOptions<S>['onDrop'];
  /** Insertion order is expiry order, because the window is the same for every session. */
  readonly #parked = new Map<string, { session: S; expiresAt: number }>();
  #claimed = 0;
  #expired = 0;
  #evicted = 0;

  constructor(options: ResumeRegistryOptions<S> = {}) {
    this.#windowMs = options.windowMs ?? RESUME_WINDOW_MS;
    this.#maxParked = options.maxParked ?? DEFAULT_MAX_PARKED;
    this.#onDrop = options.onDrop;
    if (!(this.#windowMs > 0) || !(this.#maxParked >= 1)) {
      throw new RangeError('resume window and capacity must be positive');
    }
  }

  get size(): number {
    return this.#parked.size;
  }

  get stats(): ResumeRegistryStats {
    return {
      parked: this.#parked.size,
      claimed: this.#claimed,
      expired: this.#expired,
      evicted: this.#evicted,
    };
  }

  park(id: string, session: S, now: number): void {
    this.#parked.delete(id);
    this.sweep(now);
    while (this.#parked.size >= this.#maxParked) {
      const oldest = this.#parked.entries().next();
      if (oldest.done) break;
      const [oldestId, entry] = oldest.value;
      this.#parked.delete(oldestId);
      this.#evicted += 1;
      this.#onDrop?.(oldestId, entry.session, 'evicted');
    }
    this.#parked.set(id, { session, expiresAt: now + this.#windowMs });
  }

  /** Hands the session back (once), unless it is unknown or its window has run out. */
  claim(id: string, now: number): S | undefined {
    const entry = this.#parked.get(id);
    if (entry === undefined) return undefined;
    this.#parked.delete(id);
    if (now > entry.expiresAt) {
      this.#expired += 1;
      this.#onDrop?.(id, entry.session, 'expired');
      return undefined;
    }
    this.#claimed += 1;
    return entry.session;
  }

  /** Forgets sessions whose window has run out and returns their ids. */
  sweep(now: number): string[] {
    const gone: string[] = [];
    for (const [id, entry] of this.#parked) {
      if (now <= entry.expiresAt) break;
      this.#parked.delete(id);
      this.#expired += 1;
      gone.push(id);
      this.#onDrop?.(id, entry.session, 'expired');
    }
    return gone;
  }
}

export type ResumeOutcome = 'continue' | 'gap-snapshot' | 'snapshot';

/**
 * Prepares one outbox for a resumed client that last saw `lastSeq` on this subscription
 * (undefined: nothing yet).
 */
export function resumeOutbox(
  outbox: Outbox,
  lastSeq: number | undefined,
): ResumeOutcome {
  if (outbox.qos !== 'lossless') {
    outbox.resync();
    return 'snapshot';
  }
  const after = lastSeq ?? 0;
  if (outbox.rewind(after)) return 'continue';
  outbox.resync({
    fromSeq: Math.min(after + 1, outbox.lastSeq),
    reason: 'resume-unavailable',
  });
  return 'gap-snapshot';
}
