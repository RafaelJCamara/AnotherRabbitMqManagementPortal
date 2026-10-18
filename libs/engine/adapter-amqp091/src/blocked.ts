// The broker's flow control as seen by this connection (`connection.blocked` / `connection.unblocked`,
// sent when a memory or disk alarm stops it reading from publishers). A blocked connection cannot
// confirm a copy, so a publish that finds it blocked fails fast with the outcome `blocked` and
// nothing is sent (blueprint 5.5: "blocked means no rescue").
import { safeText } from './errors.ts';

export interface BlockedSnapshot {
  readonly blocked: boolean;
  /** The broker's text, shortened, while blocked. */
  readonly reason: string | undefined;
  /** Milliseconds since the epoch at which the block began, while blocked. */
  readonly since: number | undefined;
}

export class BlockedState {
  readonly #now: () => number;
  #blocked = false;
  #reason: string | undefined;
  #since: number | undefined;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  block(reason: string): void {
    if (!this.#blocked) this.#since = this.#now();
    this.#blocked = true;
    this.#reason = safeText(reason, 200);
  }

  unblock(): void {
    this.#blocked = false;
    this.#reason = undefined;
    this.#since = undefined;
  }

  isBlocked(): boolean {
    return this.#blocked;
  }

  snapshot(): BlockedSnapshot {
    return {
      blocked: this.#blocked,
      reason: this.#reason,
      since: this.#since,
    };
  }
}
