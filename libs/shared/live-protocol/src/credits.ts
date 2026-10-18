// Credit accounting for one subscription (blueprint 3.5): every data, snapshot and delta frame
// consumes one credit, and the client grants credits after it has rendered. The balance can never
// go negative because `consume` refuses instead of going below zero.

/** Upper bound on one subscription's balance, so a misbehaving client cannot grow it without limit. */
export const MAX_CREDITS = 1_048_576;

export interface CreditStats {
  /** Credits accepted, including the initial credit of `sub`. */
  readonly granted: number;
  readonly consumed: number;
  /** Credits thrown away by `reset` (a resumed session starts again at zero). */
  readonly discarded: number;
  /** Surplus grants that would have pushed the balance above `MAX_CREDITS`. */
  readonly refused: number;
}

function assertCount(n: number, what: string): void {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(
      `${what} must be a non-negative integer, got ${String(n)}`,
    );
  }
}

export class Credits {
  #available = 0;
  #granted = 0;
  #consumed = 0;
  #discarded = 0;
  #refused = 0;

  constructor(initial = 0) {
    this.grant(initial);
  }

  get available(): number {
    return this.#available;
  }

  get stats(): CreditStats {
    return {
      granted: this.#granted,
      consumed: this.#consumed,
      discarded: this.#discarded,
      refused: this.#refused,
    };
  }

  /** Adds credits and returns how many were accepted (the balance saturates at `MAX_CREDITS`). */
  grant(n: number): number {
    assertCount(n, 'credit');
    const accepted = Math.min(n, MAX_CREDITS - this.#available);
    this.#available += accepted;
    this.#granted += accepted;
    this.#refused += n - accepted;
    return accepted;
  }

  /** Spends one credit. Throws, and changes nothing, when none is left: callers check first. */
  consume(): void {
    if (this.#available === 0) {
      throw new RangeError('no credit left to consume');
    }
    this.#available -= 1;
    this.#consumed += 1;
  }

  /** Drops the balance to zero; the client grants again after a resume. */
  reset(): void {
    this.#discarded += this.#available;
    this.#available = 0;
  }
}
