import type { ServerFrame } from '@app/contracts';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SESSION_LIMITS, LiveSession } from './session.ts';
import {
  credit,
  HELLO,
  notFound,
  open,
  spec,
  sub,
  wire,
} from './test-support.ts';

describe('handshake and limits', () => {
  it('welcomes with the session limits and sets them to 64 / 8 MiB / 1 MiB', () => {
    const session = new LiveSession({
      id: 'abc',
      engineVersion: '1.2.3',
      resolve: () => ({ ok: true, spec: spec() }),
    });
    const { frames } = session.receive(HELLO);
    expect(wire(frames)).toEqual([
      {
        t: 'welcome',
        v: 1,
        session: 'abc',
        engineVersion: '1.2.3',
        limits: {
          maxSubs: 64,
          outboxBytes: 8 * 1024 * 1024,
          maxFrameBytes: 1024 * 1024,
        },
      },
    ]);
    expect(DEFAULT_SESSION_LIMITS).toEqual({
      maxSubs: 64,
      outboxBytes: 8_388_608,
      maxFrameBytes: 1_048_576,
    });
    expect(session.state).toBe('open');
  });

  it('flags a second hello and any frame before hello as a violation, but answers ping', () => {
    const session = new LiveSession({
      id: 's',
      engineVersion: 'v',
      resolve: () => ({ ok: true, spec: spec() }),
    });
    expect(session.receive(sub(1, 'a.b', 1)).violation).toBeDefined();
    expect(session.receive({ t: 'ping', ts: 7 }).frames).toEqual([
      { t: 'pong', ts: 7 },
    ]);
    session.receive(HELLO);
    expect(session.receive(HELLO).violation).toBeDefined();
  });

  it('refuses the 65th subscription with a Problem and keeps the 64 others', () => {
    const session = open({ 'a.b': spec() });
    for (let sid = 1; sid <= 64; sid++) {
      expect(session.receive(sub(sid, 'a.b', 1)).frames).toEqual([
        { t: 'subok', sid, qos: 'lossless' },
      ]);
    }
    const refused = session.receive(sub(65, 'a.b', 1));
    expect(refused.violation).toBeUndefined();
    const [end] = wire(refused.frames);
    expect(end).toMatchObject({
      t: 'end',
      sid: 65,
      reason: 'error',
      problem: { code: 'BUDGET_EXCEEDED', status: 429 },
    });
    expect(session.subscriptionCount).toBe(64);
    // A freed slot can be used again.
    session.receive({ t: 'unsub', sid: 3 });
    expect(session.receive(sub(65, 'a.b', 1)).frames[0]?.t).toBe('subok');
  });

  it('rejects a reused sid, answers unknown topics with end/error, and ignores races', () => {
    const session = open({ 'a.b': spec() });
    session.receive(sub(1, 'a.b', 1));
    expect(session.receive(sub(1, 'a.b', 1)).violation).toBeDefined();
    const unknown = session.receive(sub(2, 'x.y', 1));
    expect(wire(unknown.frames)[0]).toMatchObject({
      t: 'end',
      sid: 2,
      problem: { code: 'NOT_FOUND' },
    });
    expect(session.receive(credit(99, 5))).toEqual({ frames: [] });
    expect(session.receive({ t: 'unsub', sid: 99 })).toEqual({ frames: [] });
    expect(session.receive({ t: 'unsub', sid: 1 }).frames).toEqual([
      { t: 'end', sid: 1, reason: 'unsub' },
    ]);
    expect(session.subscriptionCount).toBe(0);
  });

  it('goaway drains: existing subscriptions go on, new ones are refused', () => {
    const session = open({ 'a.b': spec() });
    session.receive(sub(1, 'a.b', 1));
    expect(session.goaway('drain', 500)).toEqual({
      t: 'goaway',
      reason: 'drain',
      reconnectAfterMs: 500,
    });
    expect(session.goaway('drain')).toEqual({ t: 'goaway', reason: 'drain' });
    expect(session.state).toBe('draining');
    const refused = session.receive(sub(2, 'a.b', 1));
    expect(wire(refused.frames)[0]).toMatchObject({
      problem: { code: 'ENGINE_SHUTTING_DOWN', retryable: true },
    });
    session.publish(1, { value: 'x', bytes: 1 });
    expect(session.drain(0).frames).toHaveLength(1);
  });

  it('ends a subscription from the engine side and ignores a stale publish', () => {
    const session = open({ 'a.b': spec() });
    session.receive(sub(1, 'a.b', 1));
    expect(session.end(1, 'completed')).toEqual([
      { t: 'end', sid: 1, reason: 'completed' },
    ]);
    expect(session.end(1, 'completed')).toEqual([]);
    expect(session.publish(1, { value: 1, bytes: 1 })).toBe(false);
    expect(session.publishRemove(1, 'k')).toBe(false);
    session.receive(sub(2, 'a.b', 1));
    const problem = notFound('x');
    expect(session.end(2, 'error', problem)).toEqual([
      { t: 'end', sid: 2, reason: 'error', problem },
    ]);
    session.close();
    expect(session.state).toBe('closed');
    expect(session.drain(0)).toEqual({ frames: [], wakeAt: null });
  });
});

describe('credits', () => {
  it('sends nothing without credit, one frame per credit, and the balance never goes negative', () => {
    const session = open({ 'a.b': spec() });
    session.receive(sub(1, 'a.b', 2));
    const sent: ServerFrame[] = [];
    for (let i = 1; i <= 4; i++) {
      session.publish(1, { value: i, bytes: 1 });
      sent.push(...session.drain(i).frames);
      expect(session.inspect(1)?.credits).toBeGreaterThanOrEqual(0);
    }
    expect(sent).toEqual([
      { t: 'data', sid: 1, seq: 1, items: [1] },
      { t: 'data', sid: 1, seq: 2, items: [2] },
    ]);
    expect(session.inspect(1)).toMatchObject({ credits: 0, items: 4 });
    session.receive(credit(1, 1));
    // The two waiting items go out together in the one frame the new credit pays for.
    expect(session.drain(5).frames).toEqual([
      { t: 'data', sid: 1, seq: 4, items: [3, 4] },
    ]);
    expect(session.inspect(1)?.credits).toBe(0);
  });
});

describe('snapshot-delta and sampled topics', () => {
  it('sends a snapshot first, then deltas, using the credits it is given', () => {
    const state = new Map<string, number>([['a', 1]]);
    const session = open({
      'w.x': spec({
        qos: 'latest',
        flow: 'snapshot-delta',
        key: (item) => (item as { k: string }).k,
        snapshot: () => ({
          value: [...state].map(([k, v]) => ({ k, v })),
          bytes: state.size,
        }),
      }),
    });
    session.receive(sub(1, 'w.x', 0));
    expect(session.drain(0).frames).toEqual([]);
    session.receive(credit(1, 3));
    expect(wire(session.drain(0).frames)).toEqual([
      { t: 'snapshot', sid: 1, seq: 0, items: [{ k: 'a', v: 1 }] },
    ]);
    session.publish(1, { value: { k: 'b', v: 2 }, bytes: 4 });
    session.publishRemove(1, 'a');
    expect(wire(session.drain(1).frames)).toEqual([
      {
        t: 'delta',
        sid: 1,
        seq: 2,
        upserts: [{ k: 'b', v: 2 }],
        removes: ['a'],
      },
    ]);
  });

  it('ends a subscription whose snapshot would not fit in a frame', () => {
    const session = open(
      {
        'w.x': spec({
          qos: 'latest',
          flow: 'snapshot-delta',
          key: () => 'k',
          snapshot: () => ({ value: [], bytes: 100 }),
        }),
      },
      { maxFrameBytes: 50 },
    );
    session.receive(sub(1, 'w.x', 1));
    const { frames } = session.drain(0);
    expect(wire(frames)[0]).toMatchObject({
      t: 'end',
      reason: 'error',
      problem: { code: 'BUDGET_EXCEEDED', status: 413 },
    });
    expect(session.subscriptionCount).toBe(0);
  });

  it('carries the dropped and sampledEvery counters of a sampled topic', () => {
    const session = open({
      's.t': spec({
        qos: 'sampled',
        sampleEvery: 2,
        ring: { items: 2, bytes: 100 },
      }),
    });
    session.receive(sub(1, 's.t', 1));
    for (let i = 0; i < 8; i++) session.publish(1, { value: i, bytes: 1 });
    expect(wire(session.drain(0).frames)).toEqual([
      { t: 'data', sid: 1, seq: 7, items: [4, 6], dropped: 2, sampledEvery: 2 },
    ]);
  });
});

describe('session outbox budget', () => {
  it('never lets the outboxes of one session hold more than the session limit', () => {
    const session = open(
      { 'm.a': spec({ qos: 'latest', ring: { items: 8, bytes: 100 } }) },
      { outboxBytes: 10 },
    );
    session.receive(sub(1, 'm.a', 0));
    session.receive(sub(2, 'm.a', 0));
    session.publish(1, { value: 'x', bytes: 8 });
    session.publish(2, { value: 'y', bytes: 8 });
    expect(session.outboxBytes).toBe(8);
    expect(session.inspect(2)).toMatchObject({ bytes: 0, dropped: 1 });
    // A lossless subscription over budget reports a gap instead.
    const lossless = open({ 'l.a': spec() }, { outboxBytes: 10 });
    lossless.receive(sub(1, 'l.a', 1));
    lossless.publish(1, { value: 'x', bytes: 6 });
    lossless.publish(1, { value: 'y', bytes: 6 });
    expect(lossless.drain(0).frames).toEqual([
      { t: 'gap', sid: 1, fromSeq: 1, toSeq: 2, reason: 'overflow' },
      { t: 'snapshot', sid: 1, seq: 2, items: [] },
    ]);
  });
});
