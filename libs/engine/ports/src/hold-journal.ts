// The hold journal of the peek executor (M1-14, blueprint 5.5). One row per peek hold: written
// `acquiring` before the first `get`, then settled, or marked as an incident. A crashed process
// leaves its `acquiring` rows behind; `listInterrupted` finds them at start.
//
// The queue name arrives sealed by the caller (ADR-014 covers the journal): the repository stores
// the bytes as they are and never opens them. Every list is bounded by `limit` (I-7).

export type HoldState = 'acquiring' | 'settled' | 'incident';

export interface HoldOpen {
  readonly id: string;
  readonly connectionId: string;
  readonly vhost: string;
  /** The queue name, sealed by the caller. */
  readonly queueSealed: Uint8Array;
  readonly startedAt: number;
}

export interface InterruptedHold {
  readonly id: string;
  readonly connectionId: string;
  readonly vhost: string;
}

export interface HoldJournalRepository {
  open(hold: HoldOpen): Promise<void>;
  /** Marks an `acquiring` row `settled` with the number of deliveries returned to the queue. */
  settle(id: string, returned: number, endedAt: number): Promise<void>;
  /** Marks an `acquiring` row `incident` with a fixed reason text (never input bytes). */
  markIncident(id: string, reason: string, endedAt: number): Promise<void>;
  /** At most `limit` rows still in `acquiring`, oldest first. */
  listInterrupted(limit: number): Promise<readonly InterruptedHold[]>;
}
