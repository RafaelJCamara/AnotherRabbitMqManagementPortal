import type {
  Delivery,
  HoldJournalRepository,
  HoldOpen,
  InterruptedHold,
  PeekLease,
  ThrowawayChannel,
} from '@app/ports';
import { describe, expect, it } from 'vitest';

import {
  createPeekExecutor,
  type ExecutionHooks,
  type ExecutorPorts,
  type PeekExecution,
  QUORUM_RETURN_WAIT_MS,
} from './executor.ts';

// A fake lease over one shared log, so the order of lease calls and journal writes can be checked.
// `get` takes the next ready delivery; `nackRequeue(upTo)` returns every held delivery up to that tag
// to the front of the queue, marked redelivered.
class FakeLease {
  readonly ready: Delivery[] = [];
  readonly held: Delivery[] = [];
  maxHeld = 0;
  /** Quorum model: the returned deliveries show as ready only after this many ready-count reads. */
  readsUntilReturned = 0;
  #parked: Delivery[] = [];
  /** When set, the ready-count read fails. */
  readFails = false;
  reads = 0;
  released: 'healthy' | 'poisoned' | undefined;
  barrier: () => Promise<void> = () => Promise.resolve();
  /** When set, the `get` after this many answered gets never resolves. */
  hangAfter: number | undefined;
  readonly hangStarted: Promise<void>;
  #signalHang: () => void = () => undefined;
  #gets = 0;

  constructor(
    messages: number,
    readonly log: string[],
  ) {
    for (let n = 1; n <= messages; n += 1) this.ready.push(delivery(n, false));
    this.hangStarted = new Promise<void>((resolve) => {
      this.#signalHang = resolve;
    });
  }

  async get(): Promise<Delivery | null> {
    this.log.push('get');
    this.#gets += 1;
    if (this.hangAfter !== undefined && this.#gets > this.hangAfter) {
      this.#signalHang();
      return new Promise<Delivery | null>(() => undefined);
    }
    const next = this.ready.shift() ?? null;
    if (next !== null) {
      this.held.push(next);
      this.maxHeld = Math.max(this.maxHeld, this.held.length);
    }
    return next;
  }

  nackRequeue(upToTag: bigint): void {
    this.log.push(`nack:${String(upToTag)}`);
    const back = this.held
      .filter((d) => d.tag <= upToTag)
      .map((d) => delivery(Number(d.tag), true));
    this.held.splice(
      0,
      this.held.length,
      ...this.held.filter((d) => d.tag > upToTag),
    );
    if (this.readsUntilReturned > 0) this.#parked.push(...back);
    else this.ready.unshift(...back);
  }

  qosBarrier(): Promise<void> {
    this.log.push('barrier');
    return this.barrier();
  }

  ackWithProof(): never {
    throw new Error('ack is not part of M1-14');
  }

  throwaway<T>(fn: (channel: ThrowawayChannel) => Promise<T>): Promise<T> {
    return fn({
      checkQueue: () => {
        this.log.push('read-ready');
        this.reads += 1;
        if (this.readFails) return Promise.reject(new Error('channel closed'));
        if (this.readsUntilReturned > 0) {
          this.readsUntilReturned -= 1;
          if (this.readsUntilReturned === 0) {
            this.ready.unshift(...this.#parked);
            this.#parked = [];
          }
        }
        return Promise.resolve({
          messageCount: this.ready.length,
          consumerCount: 0,
        });
      },
    });
  }

  release(state: 'healthy' | 'poisoned'): Promise<void> {
    this.log.push(`release:${state}`);
    this.released = state;
    return Promise.resolve();
  }

  asLease(): PeekLease {
    return this;
  }
}

function delivery(n: number, redelivered: boolean): Delivery {
  return {
    tag: BigInt(n),
    redelivered,
    exchange: '',
    routingKey: 'orders.q',
    properties: {},
    headers: {},
    body: new Uint8Array(10),
  };
}

class FakeJournal implements HoldJournalRepository {
  readonly rows = new Map<string, { state: string; reason: string | null }>();

  constructor(readonly log: string[]) {}

  open(hold: HoldOpen): Promise<void> {
    this.log.push('journal:open');
    this.rows.set(hold.id, { state: 'acquiring', reason: null });
    return Promise.resolve();
  }

  settle(id: string, returned: number): Promise<void> {
    this.log.push(`journal:settle:${String(returned)}`);
    this.rows.set(id, { state: 'settled', reason: null });
    return Promise.resolve();
  }

  markIncident(id: string, reason: string): Promise<void> {
    this.log.push(`journal:incident:${reason}`);
    this.rows.set(id, { state: 'incident', reason });
    return Promise.resolve();
  }

  listInterrupted(limit: number): Promise<readonly InterruptedHold[]> {
    return Promise.resolve(
      [...this.rows.entries()]
        .filter(([, row]) => row.state === 'acquiring')
        .slice(0, limit)
        .map(([id]) => ({ id, connectionId: 'c1', vhost: '/' })),
    );
  }
}

// Fake timers on a fake clock: `advance` moves the clock and runs the callbacks that are due.
class FakeClock {
  now = 0;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();
  #seq = 0;

  setTimeout(callback: () => void, ms: number): unknown {
    this.#seq += 1;
    this.#timers.set(this.#seq, { at: this.now + ms, callback });
    return this.#seq;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  advance(ms: number): void {
    this.now += ms;
    for (const [handle, timer] of [...this.#timers.entries()]) {
      if (timer.at <= this.now) {
        this.#timers.delete(handle);
        timer.callback();
      }
    }
  }

  pending(): number {
    return this.#timers.size;
  }
}

function setup(messages: number) {
  const log: string[] = [];
  const journal = new FakeJournal(log);
  const clock = new FakeClock();
  const lease = new FakeLease(messages, log);
  let ids = 0;
  const ports: ExecutorPorts = {
    journal,
    now: () => clock.now,
    newId: () => {
      ids += 1;
      return `hold-${String(ids)}`;
    },
    sealQueue: (queue) => new TextEncoder().encode(queue),
    timers: clock,
  };
  return { log, lease, journal, clock, executor: createPeekExecutor(ports) };
}

const plan = (overrides: Partial<PeekExecution> = {}): PeekExecution => ({
  connectionId: 'c1',
  vhost: '/',
  queue: 'orders.q',
  queueType: 'classic',
  count: 20,
  bytes: 1_000_000,
  targetMs: 5_000,
  hardAbortMs: 30_000,
  ...overrides,
});

const notDoomed: ExecutionHooks = {
  guard: () => 'not-doomed',
  copy: () => Promise.resolve(),
};

const never = (): AbortSignal => new AbortController().signal;

/** Waits until a condition holds, yielding to the event loop between checks (bounded). */
async function until(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 1000 && !condition(); tries += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (!condition()) throw new Error('condition not reached');
}

const nacks = (log: readonly string[]): string[] =>
  log.filter((entry) => entry.startsWith('nack:'));

describe('executor (M1-14) peek execution', () => {
  it('M1-14 AC-1 executor returns 20 of 100 ready messages with one multiple nack and a barrier before the lazy close', async () => {
    const { log, lease, executor } = setup(100);

    const result = await executor.execute(
      lease.asLease(),
      plan(),
      notDoomed,
      never(),
    );

    expect(result).toEqual({
      outcome: 'settled',
      taken: 20,
      returned: 20,
      stop: 'count',
    });
    expect(nacks(log)).toEqual(['nack:20']);
    expect(log.indexOf('barrier')).toBeGreaterThan(log.indexOf('nack:20'));
    expect(log.indexOf('release:healthy')).toBeGreaterThan(
      log.indexOf('barrier'),
    );
    expect(log.at(-1)).toBe('release:healthy');
    // The messages are back at their positions, marked redelivered.
    expect(lease.ready[0]).toMatchObject({ tag: 1n, redelivered: true });
    expect(lease.ready).toHaveLength(100);
  });

  it('M1-14 AC-2 executor flushAll nacks and awaits the barrier before close on shutdown', async () => {
    const { log, lease, executor } = setup(5);
    let openBarrier: () => void = () => undefined;
    lease.barrier = () =>
      new Promise<void>((resolve) => {
        openBarrier = resolve;
      });

    const run = executor.execute(
      lease.asLease(),
      plan({ count: 10 }),
      notDoomed,
      never(),
    );
    await until(() => log.includes('barrier'));
    const flushed = executor.flushAll('shutdown');

    expect(lease.released).toBeUndefined();
    openBarrier();
    await flushed;
    const result = await run;

    expect(result).toEqual({
      outcome: 'settled',
      taken: 5,
      returned: 5,
      stop: 'empty',
    });
    expect(nacks(log)).toEqual(['nack:5']);
    expect(log.indexOf('release:healthy')).toBeGreaterThan(
      log.indexOf('barrier'),
    );
  });

  it('M1-14 AC-3 executor watchdog aborts at the hard limit, nacks what it holds and settles', async () => {
    const { log, lease, clock, executor, journal } = setup(10);
    lease.hangAfter = 2;

    const run = executor.execute(
      lease.asLease(),
      plan({ hardAbortMs: 30_000 }),
      notDoomed,
      never(),
    );
    await lease.hangStarted;
    clock.advance(30_000);
    const result = await run;

    expect(result).toEqual({
      outcome: 'settled',
      taken: 2,
      returned: 2,
      stop: 'watchdog',
    });
    expect(nacks(log)).toEqual(['nack:2']);
    expect(log.indexOf('barrier')).toBeGreaterThan(log.indexOf('nack:2'));
    // The `get` was still outstanding, so the lease is closed rather than reused.
    expect(lease.released).toBe('poisoned');
    expect(journal.rows.get('hold-1')).toEqual({
      state: 'settled',
      reason: null,
    });
    expect(log).toContain('journal:settle:2');
    expect(clock.pending()).toBe(0);
  });

  it('M1-14 AC-4 executor writes the hold journal row before the first get', async () => {
    const { log, lease, executor } = setup(1);

    await executor.execute(
      lease.asLease(),
      plan({ count: 1 }),
      notDoomed,
      never(),
    );

    expect(log[0]).toBe('journal:open');
    expect(log.indexOf('journal:open')).toBeLessThan(log.indexOf('get'));
  });

  it('M1-14 AC-5 executor marks the hold an incident and poisons the lease when the barrier fails', async () => {
    const { lease, journal, executor } = setup(3);
    lease.barrier = () =>
      Promise.reject(
        new Error('socket reset with a message body and a tag 99'),
      );

    const result = await executor.execute(
      lease.asLease(),
      plan({ count: 3 }),
      notDoomed,
      never(),
    );

    expect(result).toEqual({
      outcome: 'incident',
      reason: 'barrier-failed',
      returned: 0,
    });
    expect(lease.released).toBe('poisoned');
    expect(journal.rows.get('hold-1')).toEqual({
      state: 'incident',
      reason: 'barrier-failed',
    });
  });

  it('M1-14 AC-6 executor never nacks up to a tag it did not take', async () => {
    const { log, lease, executor } = setup(10);

    await executor.execute(
      lease.asLease(),
      plan({ count: 3 }),
      notDoomed,
      never(),
    );

    expect(nacks(log)).toEqual(['nack:3']);
  });

  it('M1-14 AC-7 executor holds at most the planned count of tags', async () => {
    const { lease, executor } = setup(200);

    const result = await executor.execute(
      lease.asLease(),
      plan({ count: 50 }),
      notDoomed,
      never(),
    );

    expect(result).toEqual({
      outcome: 'settled',
      taken: 50,
      returned: 50,
      stop: 'count',
    });
    expect(lease.maxHeld).toBe(50);
  });

  it('M1-14 AC-8 executor stops and returns its holds when a copy fails', async () => {
    const { log, lease, executor } = setup(10);
    let copies = 0;
    const hooks: ExecutionHooks = {
      guard: () => 'not-doomed',
      copy: () => {
        copies += 1;
        if (copies === 3) throw new Error('capture store full');
        return Promise.resolve();
      },
    };

    const result = await executor.execute(
      lease.asLease(),
      plan({ count: 10 }),
      hooks,
      never(),
    );

    expect(result).toEqual({
      outcome: 'settled',
      taken: 3,
      returned: 3,
      stop: 'copy-failed',
    });
    expect(log.filter((entry) => entry === 'get')).toHaveLength(3);
    expect(nacks(log)).toEqual(['nack:3']);
    expect(lease.released).toBe('healthy');
  });

  it('M1-14 AC-9 executor reconciles interrupted holds as incidents without touching the broker', async () => {
    const { log, journal, executor } = setup(0);
    journal.rows.set('old-1', { state: 'acquiring', reason: null });
    journal.rows.set('old-2', { state: 'acquiring', reason: null });

    const result = await executor.reconcileInterrupted();

    expect(result).toEqual({ marked: 2 });
    expect(journal.rows.get('old-1')).toEqual({
      state: 'incident',
      reason: 'interrupted',
    });
    expect(journal.rows.get('old-2')).toEqual({
      state: 'incident',
      reason: 'interrupted',
    });
    expect(log).toEqual([
      'journal:incident:interrupted',
      'journal:incident:interrupted',
    ]);
  });
});

describe('executor (M1-14) fail-closed rules', () => {
  it('refuses to acquire without a guard and writes no journal row', async () => {
    const { log, lease, executor } = setup(5);
    const hooks = {
      copy: () => Promise.resolve(),
    } as unknown as ExecutionHooks;

    const result = await executor.execute(
      lease.asLease(),
      plan(),
      hooks,
      never(),
    );

    expect(result).toEqual({
      outcome: 'incident',
      reason: 'guard-missing',
      returned: 0,
    });
    expect(log).toEqual(['release:healthy']);
  });

  it('stops at a doomed message and returns it with the others (no disposition in M1-14)', async () => {
    const { log, lease, executor } = setup(10);
    const hooks: ExecutionHooks = {
      copy: () => Promise.resolve(),
      guard: (d) => (d.tag === 4n ? 'doomed' : 'not-doomed'),
    };

    const result = await executor.execute(
      lease.asLease(),
      plan({ count: 10 }),
      hooks,
      never(),
    );

    expect(result).toEqual({
      outcome: 'settled',
      taken: 4,
      returned: 4,
      stop: 'doomed',
    });
    expect(nacks(log)).toEqual(['nack:4']);
  });

  it('refuses a plan whose hard abort is above the planner limit', async () => {
    const { log, lease, executor } = setup(5);

    const result = await executor.execute(
      lease.asLease(),
      plan({ hardAbortMs: 60_000 }),
      notDoomed,
      never(),
    );

    expect(result).toEqual({
      outcome: 'incident',
      reason: 'invalid-plan',
      returned: 0,
    });
    expect(log).toEqual(['release:healthy']);
  });
});

describe('executor (M1-14) quorum return, OQ-215', () => {
  /** Drives the fake clock while the executor polls, until the execution has finished. */
  async function run<T>(
    clock: FakeClock,
    execution: Promise<T>,
    stepMs = 25,
  ): Promise<T> {
    const state = { finished: false };
    const watched = execution.finally(() => {
      state.finished = true;
    });
    for (let tries = 0; tries < 2000 && !state.finished; tries += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      clock.advance(stepMs);
    }
    return watched;
  }

  it('M1-14 AC-1 executor on a quorum queue waits until the ready count shows the return and reports the delay', async () => {
    const { lease, executor, clock, journal } = setup(100);
    lease.readsUntilReturned = 4;
    const result = await run(
      clock,
      executor.execute(
        lease.asLease(),
        plan({ queueType: 'quorum' }),
        notDoomed,
        never(),
      ),
    );
    expect(result).toMatchObject({
      outcome: 'settled',
      taken: 20,
      returned: 20,
    });
    // The deliveries are back on the queue, and the delay is reported: more than none (the first
    // reads saw them missing) and well inside the wait.
    expect(lease.ready).toHaveLength(100);
    const delay =
      result.outcome === 'settled' ? result.returnConfirmedAfterMs : -1;
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThan(QUORUM_RETURN_WAIT_MS);
    expect([...journal.rows.values()]).toEqual([
      { state: 'settled', reason: null },
    ]);
    expect(lease.released).toBe('healthy');
  });

  it('M1-14 AC-1 executor on a quorum queue ends as an incident when the ready count never shows the return', async () => {
    const { lease, executor, clock, journal } = setup(100);
    lease.readsUntilReturned = Number.MAX_SAFE_INTEGER;
    const result = await run(
      clock,
      executor.execute(
        lease.asLease(),
        plan({ queueType: 'quorum' }),
        notDoomed,
        never(),
      ),
    );
    expect(result).toEqual({
      outcome: 'incident',
      reason: 'return-unconfirmed',
      returned: 0,
    });
    expect(clock.now).toBeGreaterThanOrEqual(QUORUM_RETURN_WAIT_MS);
    expect([...journal.rows.values()]).toEqual([
      { state: 'incident', reason: 'return-unconfirmed' },
    ]);
    // The channel itself answered the barrier: it is not poisoned.
    expect(lease.released).toBe('healthy');
  });

  it('M1-14 AC-1 executor on a quorum queue does not confirm a return it could not measure', async () => {
    const { lease, executor, clock } = setup(100);
    lease.readFails = true;
    const result = await run(
      clock,
      executor.execute(
        lease.asLease(),
        plan({ queueType: 'quorum' }),
        notDoomed,
        never(),
      ),
    );
    expect(result).toEqual({
      outcome: 'incident',
      reason: 'return-unconfirmed',
      returned: 0,
    });
    // It still nacked and waited for the barrier before anything else.
    expect(nacks(lease.log)).toEqual(['nack:20']);
  });

  it('M1-14 AC-1 executor on a classic queue reads no ready count and returns at the barrier', async () => {
    const { lease, executor } = setup(100);
    const result = await executor.execute(
      lease.asLease(),
      plan(),
      notDoomed,
      never(),
    );
    expect(result).toMatchObject({ outcome: 'settled', returned: 20 });
    expect(lease.reads).toBe(0);
    expect(result).not.toHaveProperty('returnConfirmedAfterMs');
  });

  it('refuses a plan with a queue type the executor does not peek', async () => {
    const { lease, executor } = setup(1);
    const result = await executor.execute(
      lease.asLease(),
      plan({ queueType: 'stream' as 'classic' }),
      notDoomed,
      never(),
    );
    expect(result).toMatchObject({
      outcome: 'incident',
      reason: 'invalid-plan',
    });
  });
});
