import type { ArmingClock } from '@app/ui-data';

/** A clock the spec moves. Timers run only when `advance` reaches them. Never part of the library build. */
export class ManualClock implements ArmingClock {
  at = 1_000_000;
  readonly timers = new Map<number, { due: number; run: () => void }>();
  #next = 1;
  now(): number {
    return this.at;
  }
  after(ms: number, run: () => void): () => void {
    const id = this.#next++;
    this.timers.set(id, { due: this.at + ms, run });
    return () => {
      this.timers.delete(id);
    };
  }
  advance(ms: number): void {
    this.at += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.due <= this.at) {
        this.timers.delete(id);
        timer.run();
      }
    }
  }
}
