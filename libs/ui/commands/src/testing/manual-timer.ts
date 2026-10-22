import type { CommandTimer } from '../timer';

/** A clock the spec moves: nothing runs until `advance` reaches it. No real timer is involved. */
export class ManualTimer implements CommandTimer {
  #now = 0;
  #next = 1;
  readonly #pending = new Map<number, { at: number; callback: () => void }>();
  readonly delays: number[] = [];

  set(callback: () => void, ms: number): () => void {
    const id = this.#next++;
    this.delays.push(ms);
    this.#pending.set(id, { at: this.#now + ms, callback });
    return () => {
      this.#pending.delete(id);
    };
  }

  get pending(): number {
    return this.#pending.size;
  }

  /** Moves the clock and runs, in order, every timer that came due. */
  advance(ms: number): void {
    this.#now += ms;
    for (;;) {
      const due = [...this.#pending.entries()]
        .filter(([, timer]) => timer.at <= this.#now)
        .sort(([, a], [, b]) => a.at - b.at)[0];
      if (!due) return;
      this.#pending.delete(due[0]);
      due[1].callback();
    }
  }
}
