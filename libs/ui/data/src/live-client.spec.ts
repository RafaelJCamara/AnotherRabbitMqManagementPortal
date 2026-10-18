import { TestBed } from '@angular/core/testing';
import type { ClientFrame } from '@app/contracts';
import { TransportError } from '@app/ui-platform';
import { tick } from '@app/ui-platform/testing';
import type { Observable } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { EngineProblemError } from './errors';
import {
  DEFAULT_LIVE_CLIENT_CONFIG,
  LiveClient,
  type LiveClientConfig,
  type LiveEvent,
} from './live-client';
import {
  configureTestbed,
  eventsTopic,
  gateProblem,
  smallEventsTopic,
  stateTopic,
} from './test-fixtures';

interface Timer {
  readonly callback: () => void;
  readonly ms: number;
  cancelled: boolean;
  fired: boolean;
}

/** The data layer on the in-memory carrier, with rendering and timers under the spec's control. */
function liveBed(
  overrides: Partial<LiveClientConfig> = {},
  options: { parse?: boolean } = {},
) {
  const renders: (() => void)[] = [];
  const timers: Timer[] = [];
  const bed = configureTestbed({
    ...(options.parse === undefined ? {} : { parse: options.parse }),
    live: {
      initialCredit: 4,
      maxReconnectAttempts: 3,
      reconnectDelayMs: (attempt) => attempt * 100,
      afterRender: (callback) => {
        renders.push(callback);
      },
      setTimer: (callback, ms) => {
        const timer: Timer = { callback, ms, cancelled: false, fired: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      ...overrides,
    },
  });
  const client = TestBed.inject(LiveClient);
  return {
    ...bed,
    client,
    renders,
    timers,
    /** The browser painted: every callback waiting for the next frame runs. */
    flushRender: (): void => {
      for (const callback of renders.splice(0)) callback();
    },
    /** The oldest timer that has not fired runs. */
    fireTimer: (): Timer => {
      const timer = timers.find((t) => !t.cancelled && !t.fired);
      if (timer === undefined) throw new Error('no timer is waiting');
      timer.fired = true;
      timer.callback();
      return timer;
    },
    clientFrames: <T extends ClientFrame['t']>(type: T) => {
      return bed.engine.clientFrames.filter(
        (f): f is Extract<ClientFrame, { t: T }> => f.t === type,
      );
    },
  };
}

function collect<T>(source: Observable<T>) {
  const events: T[] = [];
  const state: { error?: unknown; completed: boolean } = { completed: false };
  const subscription = source.subscribe({
    next: (event) => events.push(event),
    error: (error: unknown) => {
      state.error = error;
    },
    complete: () => {
      state.completed = true;
    },
  });
  return {
    events,
    get error() {
      return state.error;
    },
    get completed() {
      return state.completed;
    },
    unsubscribe: () => {
      subscription.unsubscribe();
    },
  };
}

const flush = (): Promise<void> => tick(0);

const itemsOf = (events: LiveEvent<{ n: number }>[]): number[] =>
  events.flatMap((e) =>
    e.kind === 'data' || e.kind === 'snapshot' ? e.items.map((i) => i.n) : [],
  );

describe('LiveClient', () => {
  describe('the session', () => {
    it('opens on the first subscription: hello, then sub with the initial credit once welcomed', async () => {
      const { client, engine } = liveBed();
      expect(client.state()).toBe('idle');
      collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      expect(client.state()).toBe('connecting');
      await flush();
      expect(client.state()).toBe('ready');
      expect(client.engineVersion()).toBe('0.0.0-fake');
      expect(engine.clientFrames).toEqual([
        { t: 'hello', v: 1 },
        {
          t: 'sub',
          sid: 1,
          topic: 'test.events',
          params: { cid: 'c1' },
          credit: 4,
        },
      ]);
    });

    it('carries many subscriptions on one session', async () => {
      const { client, engine } = liveBed();
      collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      collect(client.subscribe(stateTopic, { cid: 'c1' }));
      await flush();
      expect(engine.sessions).toHaveLength(1);
      expect(engine.clientFrames.map((f) => f.t)).toEqual([
        'hello',
        'sub',
        'sub',
      ]);
      expect(engine.sessions[0]?.subscriptionCount).toBe(2);
    });

    it('sends unsub when a subscriber leaves, and nothing more reaches it', async () => {
      const { client, engine } = liveBed();
      const events = collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      await flush();
      events.unsubscribe();
      await flush();
      expect(engine.clientFrames.at(-1)).toEqual({ t: 'unsub', sid: 1 });
      expect(engine.sessions[0]?.subscriptionCount).toBe(0);
      engine.publish('test.events', { n: 1 });
      await flush();
      expect(events.events).toEqual([]);
    });

    it('rejects an initial credit that is not a positive integer', () => {
      const { client } = liveBed();
      for (const credit of [0, -1, 1.5]) {
        expect(() =>
          client.subscribe(eventsTopic, { cid: 'c1' }, { credit }),
        ).toThrow(RangeError);
      }
    });

    it('refuses a 65th subscription with a BUDGET_EXCEEDED Problem', async () => {
      const { client } = liveBed();
      for (let i = 0; i < 64; i += 1)
        collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      await flush();
      const extra = collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      expect(extra.error).toBeInstanceOf(EngineProblemError);
      expect((extra.error as EngineProblemError).code).toBe('BUDGET_EXCEEDED');
    });

    it('destroy() completes every subscription and closes the session', async () => {
      const { client, transport } = liveBed();
      const events = collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      await flush();
      client.destroy();
      expect(events.completed).toBe(true);
      expect(client.state()).toBe('idle');
      expect(transport.opened[0]?.queue.done).toBe(true);
      const late = collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      expect(late.completed).toBe(true);
    });
  });

  describe('credit', () => {
    it('AC-2 grants credit only after a rendered batch, not when the frames arrive', async () => {
      const { client, engine, flushRender, clientFrames } = liveBed();
      const events = collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      await flush();
      for (let n = 1; n <= 6; n += 1) engine.publish('test.events', { n });
      await flush();
      // Four credits, four frames; the other two items wait in the engine's outbox.
      expect(itemsOf(events.events)).toEqual([1, 2, 3, 4]);
      expect(clientFrames('credit')).toEqual([]);

      flushRender();
      await flush();
      expect(clientFrames('credit')).toEqual([{ t: 'credit', sid: 1, n: 4 }]);
      expect(itemsOf(events.events)).toEqual([1, 2, 3, 4, 5, 6]);

      flushRender();
      await flush();
      expect(clientFrames('credit')).toEqual([
        { t: 'credit', sid: 1, n: 4 },
        // One credit per frame: the engine sent the two waiting items in a single frame.
        { t: 'credit', sid: 1, n: 1 },
      ]);
    });

    it('asks for the render once per batch and answers every subscription with one credit frame', async () => {
      const { client, engine, renders, flushRender, clientFrames } = liveBed();
      const a = collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      const b = collect(
        client.subscribe(eventsTopic, { cid: 'c1' }, { credit: 2 }),
      );
      await flush();
      engine.publish('test.events', { n: 1 });
      engine.publish('test.events', { n: 2 });
      await flush();
      expect(itemsOf(a.events)).toEqual([1, 2]);
      expect(itemsOf(b.events)).toEqual([1, 2]);
      expect(renders).toHaveLength(1);
      flushRender();
      expect(clientFrames('credit')).toEqual([
        { t: 'credit', sid: 1, n: 2 },
        { t: 'credit', sid: 2, n: 2 },
      ]);
    });

    it('grants nothing while the page is not drawing, so the engine keeps its items', async () => {
      const { client, engine, clientFrames } = liveBed();
      const events = collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      await flush();
      for (let n = 1; n <= 20; n += 1) engine.publish('test.events', { n });
      await flush();
      await tick(20);
      expect(itemsOf(events.events)).toHaveLength(4);
      expect(clientFrames('credit')).toEqual([]);
      expect(engine.sessions[0]?.inspect(1)).toMatchObject({
        credits: 0,
        items: 20,
      });
    });

    it('returns the credit of a frame it dropped as stale as well', async () => {
      const { client, transport, flushRender, clientFrames } = liveBed();
      collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      await flush();
      transport.connection.send({
        t: 'data',
        sid: 1,
        seq: 5,
        items: [{ n: 5 }],
      });
      transport.connection.send({
        t: 'data',
        sid: 1,
        seq: 4,
        items: [{ n: 4 }],
      });
      await flush();
      flushRender();
      expect(clientFrames('credit')).toEqual([{ t: 'credit', sid: 1, n: 2 }]);
    });
  });

  describe('what the subscriber sees', () => {
    it('gets the data of a lossless topic, in order, with the seq', async () => {
      const { client, engine } = liveBed();
      const events = collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      await flush();
      engine.publish('test.events', { n: 1 });
      engine.publish('test.events', { n: 2 });
      await flush();
      expect(events.events).toEqual([
        { kind: 'data', seq: 1, items: [{ n: 1 }] },
        { kind: 'data', seq: 2, items: [{ n: 2 }] },
      ]);
    });

    it('rebuilds a keyed topic from its snapshot and deltas', async () => {
      const { client, engine, flushRender } = liveBed();
      const events = collect(
        client.subscribe(stateTopic, { cid: 'c1' }, { credit: 50 }),
      );
      await flush();
      engine.publish('test.state', { id: 'a', v: 1 });
      engine.publish('test.state', { id: 'b', v: 1 });
      await flush();
      engine.publish('test.state', { id: 'a', v: 2 });
      engine.remove('test.state', 'b');
      engine.publish('test.state', { id: 'c', v: 1 });
      await flush();
      flushRender();
      await flush();

      const held = new Map<string, number>();
      for (const event of events.events) {
        if (event.kind === 'snapshot') {
          held.clear();
          for (const item of event.items) held.set(item.id, item.v);
        } else if (event.kind === 'delta') {
          for (const item of event.upserts) held.set(item.id, item.v);
          for (const key of event.removes) held.delete(key);
        }
      }
      expect(Object.fromEntries(held)).toEqual({ a: 2, c: 1 });
      expect(events.events[0]?.kind).toBe('snapshot');
    });

    it('is told about a gap, then gets a snapshot, when the engine overflowed', async () => {
      const { client, engine, flushRender } = liveBed();
      const events = collect(
        client.subscribe(smallEventsTopic, { cid: 'c1' }, { credit: 1 }),
      );
      await flush();
      for (let n = 1; n <= 10; n += 1)
        engine.publish('test.small-events', { n });
      await flush();
      flushRender();
      await flush();
      const kinds = events.events.map((e) => e.kind);
      expect(kinds.slice(0, 3)).toEqual(['data', 'gap', 'snapshot']);
      const gap = events.events[1];
      expect(gap).toMatchObject({ kind: 'gap', reason: 'overflow' });
      expect(client.stats.gaps).toBe(1);
    });

    it('passes on the topic status', async () => {
      const { client, transport } = liveBed();
      const events = collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      await flush();
      transport.connection.send({ t: 'status', sid: 1, state: 'degraded' });
      await flush();
      expect(events.events).toEqual([{ kind: 'status', state: 'degraded' }]);
    });

    it('reports the dropped and sampled counters of a data frame', async () => {
      const { client, transport } = liveBed();
      const events = collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      await flush();
      transport.connection.send({
        t: 'data',
        sid: 1,
        seq: 9,
        items: [{ n: 9 }],
        dropped: 7,
        sampledEvery: 4,
      });
      await flush();
      expect(events.events[0]).toEqual({
        kind: 'data',
        seq: 9,
        items: [{ n: 9 }],
        dropped: 7,
        sampledEvery: 4,
      });
      expect(client.stats.droppedItems).toBe(7);
    });

    it('checks every item against the topic schema in dev and test builds, and ends the subscription on drift', async () => {
      const { client, engine } = liveBed();
      const events = collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      await flush();
      engine.publish('test.events', { n: 'one' });
      await flush();
      expect(events.error).toMatchObject({ name: 'ZodError' });
      expect(engine.clientFrames.at(-1)).toEqual({ t: 'unsub', sid: 1 });
    });

    it('trusts the items when parsing is off (production builds)', async () => {
      const { client, engine } = liveBed({}, { parse: false });
      const events = collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      await flush();
      engine.publish('test.events', { n: 'one' });
      await flush();
      expect(events.error).toBeUndefined();
      expect(events.events).toHaveLength(1);
    });
  });

  describe('how a subscription ends', () => {
    it('completes when the engine says the subscription completed', async () => {
      const { client, engine } = liveBed();
      const events = collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      await flush();
      const session = engine.sessions[0];
      if (session === undefined) throw new Error('no session');
      engine.endSubscription(session, 1, 'completed');
      await flush();
      expect(events.completed).toBe(true);
      expect(events.error).toBeUndefined();
    });

    it('fails with the engine Problem, its gate and warnings included', async () => {
      const { client, engine } = liveBed();
      const events = collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      await flush();
      const session = engine.sessions[0];
      if (session === undefined) throw new Error('no session');
      engine.endSubscription(session, 1, 'error', gateProblem);
      await flush();
      const error = events.error as EngineProblemError;
      expect(error).toBeInstanceOf(EngineProblemError);
      expect(error.code).toBe('GATE_BLOCKED');
      expect(error.gate?.reason).toBe(
        'Statistics are disabled on this broker.',
      );
      expect(error.warnings).toHaveLength(2);
      expect(error.synthetic).toBe(false);
    });

    it('fails with a flagged Problem when a lease expired and the engine named no Problem', async () => {
      const { client, engine } = liveBed();
      const events = collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      await flush();
      const session = engine.sessions[0];
      if (session === undefined) throw new Error('no session');
      engine.endSubscription(session, 1, 'lease_expired');
      await flush();
      const error = events.error as EngineProblemError;
      expect(error.synthetic).toBe(true);
      expect(error.problem.title).toContain('lease_expired');
    });

    it('fails a subscription the engine refuses, with the Problem it gave', async () => {
      const { client } = liveBed();
      const events = collect(
        client.subscribe(
          { ...eventsTopic, id: 'test.nothing' as never },
          { cid: 'c1' },
        ),
      );
      await flush();
      expect((events.error as EngineProblemError).code).toBe('NOT_FOUND');
    });
  });

  describe('protocol checks', () => {
    it('counts a frame sent without credit, and still delivers it', async () => {
      const { client, transport } = liveBed();
      const events = collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      await flush();
      for (let seq = 1; seq <= 5; seq += 1) {
        transport.connection.send({
          t: 'data',
          sid: 1,
          seq,
          items: [{ n: seq }],
        });
      }
      await flush();
      expect(client.stats.creditViolations).toBe(1);
      expect(itemsOf(events.events)).toEqual([1, 2, 3, 4, 5]);
    });

    it('drops a data frame whose seq is not newer than the last delivered, and counts it', async () => {
      const { client, transport } = liveBed();
      const events = collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      await flush();
      transport.connection.send({
        t: 'data',
        sid: 1,
        seq: 5,
        items: [{ n: 5 }],
      });
      transport.connection.send({
        t: 'data',
        sid: 1,
        seq: 5,
        items: [{ n: 50 }],
      });
      transport.connection.send({
        t: 'data',
        sid: 1,
        seq: 4,
        items: [{ n: 40 }],
      });
      await flush();
      expect(itemsOf(events.events)).toEqual([5]);
      expect(client.stats.staleFrames).toBe(2);
    });

    it('accepts a snapshot with any seq: it replaces the state', async () => {
      const { client, transport } = liveBed();
      const events = collect(client.subscribe(stateTopic, { cid: 'c1' }));
      await flush();
      transport.connection.send({
        t: 'delta',
        sid: 1,
        seq: 9,
        upserts: [{ id: 'a', v: 1 }],
        removes: [],
      });
      transport.connection.send({
        t: 'snapshot',
        sid: 1,
        seq: 3,
        items: [{ id: 'z', v: 1 }],
      });
      await flush();
      // A keyed topic starts with a snapshot; the injected delta and snapshot follow it.
      expect(events.events.map((e) => e.kind)).toEqual([
        'snapshot',
        'delta',
        'snapshot',
      ]);
      expect(client.stats.staleFrames).toBe(0);
    });

    it('counts frames for a subscription it does not have', async () => {
      const { client, transport } = liveBed();
      collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      await flush();
      transport.connection.send({
        t: 'data',
        sid: 99,
        seq: 1,
        items: [{ n: 1 }],
      });
      await flush();
      expect(client.stats.orphanFrames).toBe(1);
    });
  });

  describe('connection loss', () => {
    it('resumes the same session: the missed items arrive once, with no reset', async () => {
      const { client, engine, transport, timers, fireTimer, flushRender } =
        liveBed();
      const events = collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      await flush();
      for (let n = 1; n <= 3; n += 1) engine.publish('test.events', { n });
      await flush();
      flushRender();
      await flush();

      transport.lose();
      await flush();
      expect(client.state()).toBe('reconnecting');
      expect(timers.map((t) => t.ms)).toEqual([100]);
      engine.publish('test.events', { n: 4 });
      engine.publish('test.events', { n: 5 });

      fireTimer();
      await flush();
      expect(engine.clientFrames.filter((f) => f.t === 'hello').at(-1)).toEqual(
        {
          t: 'hello',
          v: 1,
          resume: { session: 'session-1', lastSeq: { '1': 3 } },
        },
      );
      expect(client.state()).toBe('ready');
      expect(engine.sessions).toHaveLength(1);
      // Credits restart at zero after a resume, so the client grants the initial amount again.
      expect(engine.clientFrames.at(-1)).toEqual({ t: 'credit', sid: 1, n: 4 });
      expect(itemsOf(events.events)).toEqual([1, 2, 3, 4, 5]);
      expect(events.events.some((e) => e.kind === 'reset')).toBe(false);
    });

    it('tells the subscriber to start over when the engine no longer has the session', async () => {
      const { client, engine, transport, fireTimer, clientFrames } = liveBed();
      const events = collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      await flush();
      engine.publish('test.events', { n: 1 });
      await flush();

      transport.lose();
      await flush();
      engine.advance(31_000);
      fireTimer();
      await flush();

      expect(engine.sessions).toHaveLength(2);
      expect(events.events.map((e) => e.kind)).toEqual(['data', 'reset']);
      // The subscription is made again on the new session, with the full initial credit.
      expect(clientFrames('sub')).toEqual([
        {
          t: 'sub',
          sid: 1,
          topic: 'test.events',
          params: { cid: 'c1' },
          credit: 4,
        },
        {
          t: 'sub',
          sid: 1,
          topic: 'test.events',
          params: { cid: 'c1' },
          credit: 4,
        },
      ]);
      engine.publish('test.events', { n: 2 });
      await flush();
      expect(itemsOf(events.events)).toEqual([1, 2]);
      expect(events.events.at(-1)).toMatchObject({ kind: 'data', seq: 1 });
    });

    it('backs off, and gives up with a TransportError after the allowed attempts', async () => {
      const { client, transport, timers, fireTimer } = liveBed();
      const events = collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      await flush();
      transport.refuseLive = true;
      transport.lose();
      await flush();
      fireTimer();
      fireTimer();
      fireTimer();
      await flush();
      expect(timers.map((t) => t.ms)).toEqual([100, 200, 300]);
      expect(client.state()).toBe('down');
      expect(events.error).toBeInstanceOf(TransportError);
      expect(client.stats.reconnects).toBe(3);
    });

    it('connects again on the next subscription after it gave up', async () => {
      const { client, transport, fireTimer } = liveBed();
      collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      await flush();
      transport.refuseLive = true;
      transport.lose();
      await flush();
      fireTimer();
      fireTimer();
      fireTimer();
      expect(client.state()).toBe('down');
      transport.refuseLive = false;
      collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      await flush();
      expect(client.state()).toBe('ready');
    });

    it('does not reconnect with nobody subscribed, and starts a fresh session on the next subscription', async () => {
      const { client, engine, transport, timers } = liveBed();
      const events = collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      await flush();
      events.unsubscribe();
      transport.lose();
      await flush();
      expect(client.state()).toBe('idle');
      expect(timers).toEqual([]);
      collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      await flush();
      expect(engine.clientFrames.filter((f) => f.t === 'hello').at(-1)).toEqual(
        {
          t: 'hello',
          v: 1,
        },
      );
      expect(client.state()).toBe('ready');
    });

    it('sends the unsub of a subscription ended while offline once the session is back', async () => {
      const { client, engine, transport, fireTimer } = liveBed();
      const gone = collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      await flush();
      transport.lose();
      await flush();
      gone.unsubscribe();
      expect(engine.clientFrames.filter((f) => f.t === 'unsub')).toEqual([]);
      fireTimer();
      await flush();
      expect(engine.clientFrames.filter((f) => f.t === 'unsub')).toEqual([
        { t: 'unsub', sid: 1 },
      ]);
      expect(engine.sessions[0]?.subscriptionCount).toBe(1);
    });

    it('reconnects after the delay the engine names in a goaway, and keeps the goaway to show', async () => {
      const { client, engine, timers, fireTimer } = liveBed();
      const events = collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      await flush();
      const session = engine.sessions[0];
      if (session === undefined) throw new Error('no session');
      engine.goaway(session, 'version-mismatch', 250);
      await flush();
      expect(client.goaway()).toEqual({
        t: 'goaway',
        reason: 'version-mismatch',
        reconnectAfterMs: 250,
      });
      expect(client.state()).toBe('reconnecting');
      expect(timers.map((t) => t.ms)).toEqual([250]);
      fireTimer();
      await flush();
      expect(client.state()).toBe('ready');
      engine.publish('test.events', { n: 1 });
      await flush();
      expect(itemsOf(events.events)).toEqual([1]);
    });

    it('drops the credit it had not granted yet when the session is lost', async () => {
      const { client, engine, transport, flushRender, clientFrames } =
        liveBed();
      collect(client.subscribe(eventsTopic, { cid: 'c1' }));
      await flush();
      engine.publish('test.events', { n: 1 });
      await flush();
      transport.lose();
      await flush();
      flushRender();
      expect(clientFrames('credit')).toEqual([]);
    });
  });

  describe('defaults', () => {
    it('renders on the next animation frame', async () => {
      await new Promise<void>((resolve) => {
        DEFAULT_LIVE_CLIENT_CONFIG.afterRender(resolve);
      });
    });

    it('has a timer that can be cancelled', async () => {
      let fired = false;
      const cancel = DEFAULT_LIVE_CLIENT_CONFIG.setTimer(() => {
        fired = true;
      }, 1);
      cancel();
      await tick(10);
      expect(fired).toBe(false);
    });

    it('backs off from about 250 ms up to about 8 s', () => {
      const delay = DEFAULT_LIVE_CLIENT_CONFIG.reconnectDelayMs;
      expect(delay(1)).toBeGreaterThanOrEqual(200);
      expect(delay(1)).toBeLessThanOrEqual(300);
      expect(delay(3)).toBeGreaterThan(delay(1));
      expect(delay(30)).toBeLessThanOrEqual(9600);
      expect(delay(30)).toBeGreaterThanOrEqual(6400);
    });
  });
});
