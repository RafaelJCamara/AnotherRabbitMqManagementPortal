// The peek executor (M1-14, blueprint 5.5): a short, sequential `basic.get` loop that never returns
// messages by closing. A hold ends in one `nack(lastUnackedTag, multiple, requeue)`, then the
// `basic.qos` barrier, then the journal row is settled, then the lease is released (lazily, after the
// barrier). `lastUnackedTag` is the last tag this execution took, so the nack never names a tag it did
// not take (no 406). A lease whose work did not end cleanly is released `poisoned`.
//
// Not here (later work packages): the post-acquire guard and the dispositions (M1-15), the rescue
// preflight (M1-13), and the actions, receipts and captures (M1-16). The guard and the copy are hooks.
import type { Delivery, HoldJournalRepository, PeekLease } from '@app/ports';

import { StateMachine } from './state-machine.ts';

/** The hard abort the planner allows at most (blueprint 5.4, `HARD_CAP_MS`). */
export const MAX_HARD_ABORT_MS = 30_000;
/** Holds one executor runs at once. A connection runs one peek, so this is a safety bound (I-6). */
export const DEFAULT_MAX_ACTIVE_HOLDS = 64;
/** The prefetch of the barrier: a `basic.qos` round trip that proves the nack was processed (DC-04). */
const BARRIER_PREFETCH = 0;

/** What the planner decided for this peek (the caps and the hold, `PeekPlanPreview`). */
export interface PeekExecution {
  readonly connectionId: string;
  readonly vhost: string;
  readonly queue: string;
  /** `caps.count`: deliveries taken at most. */
  readonly count: number;
  /** `caps.bytes`: body bytes taken at most. */
  readonly bytes: number;
  /** `hold.targetMs`: no `get` is started after this much time. */
  readonly targetMs: number;
  /** `hold.hardAbortMs`: the watchdog aborts the execution at this time. */
  readonly hardAbortMs: number;
}

/** Why an execution stopped taking messages. */
export type StopReason =
  | 'count'
  | 'bytes'
  | 'target'
  | 'empty'
  | 'doomed'
  | 'copy-failed'
  | 'abort'
  | 'watchdog'
  | 'shutdown'
  | 'suspend';

export type ExecutionResult =
  | {
      readonly outcome: 'settled';
      readonly taken: number;
      /** Deliveries the broker confirmed back on the queue (the barrier resolved). */
      readonly returned: number;
      readonly stop: StopReason;
    }
  | {
      readonly outcome: 'incident';
      /** A fixed text, never input bytes. */
      readonly reason: string;
      /** Deliveries the broker confirmed back; 0 when the barrier did not resolve. */
      readonly returned: number;
    };

/** The per-execution hooks: the guard (M1-15 supplies the real one) and the copy (M1-16). */
export interface ExecutionHooks {
  guard(delivery: Delivery): 'not-doomed' | 'doomed';
  /** A copy of each delivery (blueprint step 2). A failure stops the loop; the holds are returned. */
  copy(delivery: Delivery): Promise<void>;
}

/** The ports the executor is built with, shared by every execution of one composition root. */
export interface ExecutorPorts {
  readonly journal: HoldJournalRepository;
  readonly now: () => number;
  readonly newId: () => string;
  /** Seals the queue name for the journal (ADR-014). */
  readonly sealQueue: (queue: string) => Uint8Array;
  readonly timers: {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  readonly maxActive?: number;
}

export interface PeekExecutor {
  execute(
    lease: PeekLease,
    plan: PeekExecution,
    hooks: ExecutionHooks,
    signal: AbortSignal,
  ): Promise<ExecutionResult>;
  /** Stops every running execution: each nacks, awaits its barrier, then releases. */
  flushAll(reason: 'shutdown' | 'suspend'): Promise<void>;
  /** Marks the `acquiring` rows a crashed process left as incidents. The broker is not touched. */
  reconcileInterrupted(): Promise<{ readonly marked: number }>;
}

/** Rows one reconcile window reads at a time (the journal's own bound). */
const RECONCILE_WINDOW = 200;

interface ActiveHold {
  readonly abortWith: (reason: StopReason) => void;
  readonly done: Promise<void>;
}

function validPlan(plan: PeekExecution): boolean {
  const positive = (value: number): boolean =>
    Number.isInteger(value) && value > 0;
  return (
    positive(plan.count) &&
    positive(plan.bytes) &&
    positive(plan.targetMs) &&
    positive(plan.hardAbortMs) &&
    plan.hardAbortMs <= MAX_HARD_ABORT_MS &&
    plan.queue.length > 0
  );
}

/**
 * Resolves with the work's value, or with `done: false` as soon as the signal aborts. The work is
 * not cancelled: a `get` that still answers after an abort is the caller's to poison (see execute).
 */
function untilAborted<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<
  { readonly done: true; readonly value: T } | { readonly done: false }
> {
  if (signal.aborted) return Promise.resolve({ done: false });
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      resolve({ done: false });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve({ done: true, value });
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('lease get failed'));
      },
    );
  });
}

export function createPeekExecutor(ports: ExecutorPorts): PeekExecutor {
  const maxActive = ports.maxActive ?? DEFAULT_MAX_ACTIVE_HOLDS;
  const active = new Map<string, ActiveHold>();

  async function release(
    lease: PeekLease,
    state: 'healthy' | 'poisoned',
  ): Promise<void> {
    try {
      await lease.release(state);
    } catch {
      // The lease is closed or refused; nothing more can be done with it, and the journal already
      // holds the outcome.
    }
  }

  async function execute(
    lease: PeekLease,
    plan: PeekExecution,
    hooks: ExecutionHooks,
    signal: AbortSignal,
  ): Promise<ExecutionResult> {
    if (!validPlan(plan)) {
      await release(lease, 'healthy');
      return { outcome: 'incident', reason: 'invalid-plan', returned: 0 };
    }
    // Fail closed: without a guard nothing is acquired (the guard decides what is doomed).
    if (typeof hooks.guard !== 'function') {
      await release(lease, 'healthy');
      return { outcome: 'incident', reason: 'guard-missing', returned: 0 };
    }
    if (active.size >= maxActive) {
      await release(lease, 'healthy');
      return { outcome: 'incident', reason: 'too-many-holds', returned: 0 };
    }

    const id = ports.newId();
    const startedAt = ports.now();
    const machine = new StateMachine();

    const abort = new AbortController();
    // The first reason to abort wins; it is read after the abort, so it lives on an object.
    const cause: { reason: StopReason | null } = { reason: null };
    const abortWith = (reason: StopReason): void => {
      cause.reason ??= reason;
      abort.abort();
    };
    const onOuterAbort = (): void => {
      abortWith('abort');
    };
    if (signal.aborted) onOuterAbort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
    const watchdog = ports.timers.setTimeout(() => {
      abortWith('watchdog');
    }, plan.hardAbortMs);

    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    active.set(id, { abortWith, done });

    const cleanUp = (): void => {
      ports.timers.clearTimeout(watchdog);
      signal.removeEventListener('abort', onOuterAbort);
      active.delete(id);
    };

    try {
      await ports.journal.open({
        id,
        connectionId: plan.connectionId,
        vhost: plan.vhost,
        queueSealed: ports.sealQueue(plan.queue),
        startedAt,
      });
    } catch {
      cleanUp();
      finish();
      await release(lease, 'healthy');
      return { outcome: 'incident', reason: 'journal-failed', returned: 0 };
    }
    machine.move('acquiring');

    let taken = 0;
    let bytes = 0;
    let lastTag: bigint | null = null;
    let stop: StopReason | null = null;
    let failure: string | null = null;
    let poisoned = false;

    try {
      for (;;) {
        if (abort.signal.aborted) {
          stop = cause.reason ?? 'abort';
          break;
        }
        if (taken >= plan.count) {
          stop = 'count';
          break;
        }
        if (bytes >= plan.bytes) {
          stop = 'bytes';
          break;
        }
        if (ports.now() - startedAt >= plan.targetMs) {
          stop = 'target';
          break;
        }
        const got = await untilAborted(lease.get(plan.queue), abort.signal);
        if (!got.done) {
          // The `get` may still answer after the nack. Its delivery would then be held on a lease
          // that is about to be reused, so the lease is poisoned: closing it returns the message.
          poisoned = true;
          stop = cause.reason ?? 'abort';
          break;
        }
        if (got.value === null) {
          stop = 'empty';
          break;
        }
        const delivery = got.value;
        taken += 1;
        bytes += delivery.body.byteLength;
        lastTag = delivery.tag;
        try {
          await hooks.copy(delivery);
        } catch {
          stop = 'copy-failed';
          break;
        }
        if (hooks.guard(delivery) === 'doomed') {
          stop = 'doomed';
          break;
        }
      }
    } catch {
      // A `get` that failed (the channel or connection is in trouble): nothing more is trusted.
      failure = 'get-failed';
      poisoned = true;
    }

    // Returning: the holds are given back even after a failed `get`, so every delivery taken is
    // covered by the nack. `returned` counts only what the barrier confirmed.
    machine.move('returning');
    let returned = 0;
    if (lastTag !== null) {
      let nacked = false;
      try {
        lease.nackRequeue(lastTag, { multiple: true, requeue: true });
        nacked = true;
      } catch {
        failure ??= 'nack-failed';
        poisoned = true;
      }
      if (nacked) {
        try {
          await lease.qosBarrier(BARRIER_PREFETCH);
          returned = taken;
        } catch {
          failure ??= 'barrier-failed';
          poisoned = true;
        }
      }
    }

    // The journal is written after the broker side is settled. If that write fails, the row stays
    // `acquiring`, and the next start's reconcile marks it as interrupted.
    const endedAt = ports.now();
    let journalFailed = false;
    try {
      if (failure === null) await ports.journal.settle(id, returned, endedAt);
      else await ports.journal.markIncident(id, failure, endedAt);
    } catch {
      journalFailed = true;
    }
    const ok = failure === null && !journalFailed;
    machine.move(ok ? 'settled' : 'incident');

    cleanUp();
    await release(lease, poisoned ? 'poisoned' : 'healthy');
    finish();

    if (!ok) {
      return {
        outcome: 'incident',
        reason: failure ?? 'journal-failed',
        returned,
      };
    }
    return {
      outcome: 'settled',
      taken,
      returned,
      stop: stop ?? 'empty',
    };
  }

  return {
    execute,

    async flushAll(reason): Promise<void> {
      const holds = [...active.values()];
      for (const hold of holds) hold.abortWith(reason);
      await Promise.all(holds.map((hold) => hold.done));
    },

    async reconcileInterrupted(): Promise<{ readonly marked: number }> {
      let marked = 0;
      for (;;) {
        const rows = await ports.journal.listInterrupted(RECONCILE_WINDOW);
        for (const row of rows) {
          await ports.journal.markIncident(row.id, 'interrupted', ports.now());
          marked += 1;
        }
        if (rows.length < RECONCILE_WINDOW) return { marked };
      }
    },
  };
}
