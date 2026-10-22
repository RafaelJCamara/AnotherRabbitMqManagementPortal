import { TestBed } from '@angular/core/testing';
import type { Problem } from '@app/contracts';
import {
  jsonResponse,
  problemResponse,
  type FakeHandler,
} from '@app/ui-platform/testing';
import { describe, expect, it } from 'vitest';

import {
  ARMING_CLOCK,
  ArmingStore,
  lockGate,
  PROD_LOCK_SOURCE,
} from './arming-store';
import { EngineProblemError } from './errors';
import { configureTestbed } from './test-fixtures';

/** A clock the spec moves. Timers run only when `advance` reaches them. */
class ManualClock {
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

const refused: Problem = {
  type: 'about:blank',
  title: 'Forbidden',
  status: 403,
  code: 'FORBIDDEN_RBAC',
  detail: 'Only a person at the UI or the CLI can arm a connection.',
  correlationId: 'req-1',
  retryable: false,
};

function armingEngine(calls: string[], window = 15 * 60_000): FakeHandler {
  return (request) => {
    const url = new URL(request.url, 'http://engine.test');
    calls.push(`${request.method} ${url.pathname}`);
    const match = /^\/api\/v1\/connections\/([^/]+)\/(arm|disarm)$/.exec(
      url.pathname,
    );
    if (request.method !== 'POST' || match === null) {
      return problemResponse({ ...refused, status: 404, code: 'NOT_FOUND' });
    }
    const [, cid, verb] = match;
    if (cid === 'denied') return problemResponse(refused);
    // The engine's clock is far from the page's: only the length of the window may be used.
    return verb === 'arm'
      ? jsonResponse(200, {
          armed: true,
          connectionId: cid,
          armedAt: 5_000,
          expiresAt: 5_000 + window,
        })
      : jsonResponse(200, { armed: false, connectionId: cid, wasArmed: true });
  };
}

function setup(window?: number): {
  store: ArmingStore;
  clock: ManualClock;
  calls: string[];
} {
  const calls: string[] = [];
  const clock = new ManualClock();
  configureTestbed({
    engine: { handler: armingEngine(calls, window) },
    providers: [{ provide: ARMING_CLOCK, useValue: clock }],
  });
  return { store: TestBed.inject(ArmingStore), clock, calls };
}

describe('lockGate', () => {
  const closed = {
    enabled: false,
    reason: 'Locked.',
    source: PROD_LOCK_SOURCE,
    fix: { actionId: 'ops.arm', input: { connectionId: 'c1' } },
  };

  it('AC-1 a prod connection that is not armed is a closed gate with the reason, the source prod-lock and the engine fix ops.arm', () => {
    expect(
      lockGate({
        cid: 'c1',
        envClass: 'prod',
        armed: false,
        reason: 'Locked.',
      }),
    ).toEqual(closed);
  });

  it('AC-1 an unset, null or unknown class reads as prod and is closed too', () => {
    for (const envClass of [undefined, null, '', 'production', 'DEV', 7]) {
      expect(
        lockGate({ cid: 'c1', envClass, armed: false, reason: 'Locked.' }),
        String(envClass),
      ).toEqual(closed);
    }
  });

  it('AC-1 an armed prod connection and every non-prod class are open', () => {
    expect(
      lockGate({ cid: 'c1', envClass: 'prod', armed: true, reason: 'x' }),
    ).toEqual({ enabled: true });
    for (const envClass of ['staging', 'test', 'dev', 'local']) {
      expect(
        lockGate({ cid: 'c1', envClass, armed: false, reason: 'x' }),
      ).toEqual({ enabled: true });
    }
  });
});

describe('ArmingStore', () => {
  it('AC-10 knows nothing at first: every connection reads as not armed', () => {
    const { store } = setup();
    expect(store.armed('c1')()).toBe(false);
    expect(store.until('c1')).toBeNull();
  });

  it('AC-10 an unlock calls ops.arm once for that connection and arms it for the length of the answer', async () => {
    const { store, clock, calls } = setup();
    const outcome = await store.arm('c1');
    expect(outcome).toEqual({ ok: true, validForMs: 15 * 60_000 });
    expect(calls).toEqual(['POST /api/v1/connections/c1/arm']);
    expect(store.armed('c1')()).toBe(true);
    expect(store.armed('c2')()).toBe(false);
    // The window is counted on the page's clock from the length of the answer, not the engine's timestamps.
    expect(store.until('c1')).toBe(clock.at + 15 * 60_000);
  });

  it('AC-10 the window closes by itself at its end, and not a moment before', async () => {
    const { store, clock } = setup();
    await store.arm('c1');
    clock.advance(15 * 60_000 - 1);
    expect(store.armed('c1')()).toBe(true);
    clock.advance(1);
    expect(store.armed('c1')()).toBe(false);
    expect(store.until('c1')).toBeNull();
    expect(clock.timers.size).toBe(0);
  });

  it('AC-10 arming again restarts the window and leaves one timer', async () => {
    const { store, clock } = setup();
    await store.arm('c1');
    clock.advance(10 * 60_000);
    await store.arm('c1');
    expect(clock.timers.size).toBe(1);
    clock.advance(10 * 60_000);
    expect(store.armed('c1')()).toBe(true);
    clock.advance(5 * 60_000);
    expect(store.armed('c1')()).toBe(false);
  });

  it('AC-10 locking again calls ops.disarm and closes the window', async () => {
    const { store, clock, calls } = setup();
    await store.arm('c1');
    const outcome = await store.disarm('c1');
    expect(outcome).toEqual({ ok: true, wasArmed: true });
    expect(calls).toEqual([
      'POST /api/v1/connections/c1/arm',
      'POST /api/v1/connections/c1/disarm',
    ]);
    expect(store.armed('c1')()).toBe(false);
    expect(clock.timers.size).toBe(0);
  });

  it('AC-1 a refused unlock keeps the Problem as sent and arms nothing', async () => {
    const { store } = setup();
    const outcome = await store.arm('denied');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(EngineProblemError);
      expect((outcome.error as EngineProblemError).problem).toEqual(refused);
    }
    expect(store.armed('denied')()).toBe(false);
    expect(store.busy()).toBe(false);
  });

  it('AC-8 when the engine says a connection is locked the store forgets any window it had', async () => {
    const { store, clock } = setup();
    await store.arm('c1');
    store.noteLocked('c1');
    expect(store.armed('c1')()).toBe(false);
    expect(clock.timers.size).toBe(0);
  });
});
