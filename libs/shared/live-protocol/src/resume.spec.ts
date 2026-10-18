import { ClientFrameSchema, type ClientFrame } from '@app/contracts';
import { describe, expect, it } from 'vitest';
import { createOutbox } from './outbox.ts';
import { RESUME_WINDOW_MS, ResumeRegistry, resumeOutbox } from './resume.ts';
import { acceptHello, LiveSession } from './session.ts';
import { credit, open, spec, sub, wire } from './test-support.ts';

function hello(
  session: string,
  lastSeq: Record<string, number>,
): Extract<ClientFrame, { t: 'hello' }> {
  return ClientFrameSchema.parse({
    t: 'hello',
    v: 1,
    resume: { session, lastSeq },
  }) as Extract<ClientFrame, { t: 'hello' }>;
}

describe('ResumeRegistry', () => {
  it('keeps a session for 30 s, hands it back once, then forgets it', () => {
    expect(RESUME_WINDOW_MS).toBe(30_000);
    const registry = new ResumeRegistry<string>();
    registry.park('a', 'session-a', 1000);
    expect(registry.claim('a', 1000 + 30_000)).toBe('session-a');
    expect(registry.claim('a', 1000 + 30_000)).toBeUndefined();
    registry.park('b', 'session-b', 0);
    expect(registry.claim('b', 30_001)).toBeUndefined();
    expect(registry.stats).toEqual({
      parked: 0,
      claimed: 1,
      expired: 1,
      evicted: 0,
    });
    expect(registry.claim('nobody', 0)).toBeUndefined();
  });

  it('sweeps expired sessions and reports their ids', () => {
    const registry = new ResumeRegistry<number>();
    registry.park('a', 1, 0);
    registry.park('b', 2, 10_000);
    expect(registry.sweep(30_001)).toEqual(['a']);
    expect(registry.size).toBe(1);
    expect(registry.sweep(40_001)).toEqual(['b']);
    expect(registry.stats.expired).toBe(2);
  });

  it('is bounded: the oldest parked session is evicted and counted', () => {
    const registry = new ResumeRegistry<number>({ maxParked: 2 });
    registry.park('a', 1, 0);
    registry.park('b', 2, 1);
    registry.park('c', 3, 2);
    expect(registry.size).toBe(2);
    expect(registry.claim('a', 3)).toBeUndefined();
    expect(registry.claim('c', 3)).toBe(3);
    expect(registry.stats.evicted).toBe(1);
  });

  it('rejects a zero window or capacity', () => {
    expect(() => new ResumeRegistry({ windowMs: 0 })).toThrow(RangeError);
    expect(() => new ResumeRegistry({ maxParked: 0 })).toThrow(RangeError);
  });
});

describe('resumeOutbox', () => {
  const options = { bounds: { items: 4, bytes: 100 }, maxFrameBytes: 50 };

  it('continues a lossless outbox that still holds what the client missed', () => {
    const box = createOutbox<number>('lossless', options);
    for (let v = 1; v <= 3; v++)
      box.push({ value: v, bytes: 1 }, undefined, 1000);
    box.take(0);
    expect(resumeOutbox(box, 1)).toBe('continue');
    expect(box.take(0)).toEqual({ kind: 'data', seq: 3, items: [2, 3] });
  });

  it('answers a lossless outbox that lost items with a gap that starts after the last seq seen', () => {
    const box = createOutbox<number>('lossless', {
      ...options,
      bounds: { items: 2, bytes: 100 },
    });
    for (let v = 1; v <= 4; v++)
      box.push({ value: v, bytes: 1 }, undefined, 1000);
    box.take(0);
    expect(resumeOutbox(box, 1)).toBe('gap-snapshot');
    expect(box.take(0)).toEqual({
      kind: 'snapshot',
      seq: 4,
      gap: { fromSeq: 2, toSeq: 4, reason: 'resume-unavailable' },
    });
  });

  it('a client ahead of the engine gets a snapshot, never a gap that runs backwards', () => {
    const box = createOutbox<number>('lossless', options);
    box.push({ value: 1, bytes: 1 }, undefined, 1000);
    box.take(0);
    expect(resumeOutbox(box, 9)).toBe('gap-snapshot');
    expect(box.take(0)).toEqual({
      kind: 'snapshot',
      seq: 1,
      gap: { fromSeq: 1, toSeq: 1, reason: 'resume-unavailable' },
    });
  });

  it('gives latest and sampled topics a plain snapshot', () => {
    for (const qos of ['latest', 'sampled'] as const) {
      const box = createOutbox<number>(qos, options);
      box.push({ value: 1, bytes: 1 }, 'k', 1000);
      box.take(0);
      expect(resumeOutbox(box, 1)).toBe('snapshot');
      expect(box.take(0)).toEqual({ kind: 'snapshot', seq: 1 });
    }
  });

  it('keeps an earlier pending gap when the client missed less', () => {
    const box = createOutbox<number>('lossless', {
      ...options,
      bounds: { items: 1, bytes: 100 },
    });
    box.push({ value: 1, bytes: 1 }, undefined, 1000);
    box.take(0);
    box.push({ value: 2, bytes: 1 }, undefined, 1000);
    box.push({ value: 3, bytes: 1 }, undefined, 1000);
    // Overflow is pending (gap 2..3); the client also lost seq 1 in transit.
    expect(resumeOutbox(box, 0)).toBe('gap-snapshot');
    expect(box.take(0)).toMatchObject({ gap: { fromSeq: 1, toSeq: 3 } });
  });
});

describe('resuming a session', () => {
  const lossless = () =>
    open(
      { 'l.t': spec({ ring: { items: 3, bytes: 100 } }) },
      undefined,
      'sess-1',
    );

  it('continues from lastSeq, keeps subscriptions, and restarts credits at zero', () => {
    const registry = new ResumeRegistry<LiveSession>();
    const session = lossless();
    session.receive(sub(1, 'l.t', 5));
    for (let v = 1; v <= 3; v++) session.publish(1, { value: v, bytes: 1 });
    session.drain(0);
    session.park(registry, 100);
    expect(session.state).toBe('detached');
    expect(session.drain(100)).toEqual({ frames: [], wakeAt: null });
    // Published while the transport was down.
    session.publish(1, { value: 4, bytes: 1 });

    const result = acceptHello(
      registry,
      open({}, undefined, 'fresh'),
      hello('sess-1', { '1': 2 }),
      20_000,
    );
    expect(result.session).toBe(session);
    expect(wire(result.frames)).toEqual([
      expect.objectContaining({ t: 'welcome', session: 'sess-1' }),
      { t: 'subok', sid: 1, qos: 'lossless' },
    ]);
    expect(session.inspect(1)?.credits).toBe(0);
    expect(session.drain(20_000).frames).toEqual([]);
    session.receive(credit(1, 1));
    expect(session.drain(20_000).frames).toEqual([
      { t: 'data', sid: 1, seq: 4, items: [3, 4] },
    ]);
  });

  it('starts a new session when the parked one is unknown or expired', () => {
    const registry = new ResumeRegistry<LiveSession>();
    const session = lossless();
    session.park(registry, 0);
    // A fresh connection has not said hello yet, so build a bare session rather than `open`.
    const bare = new LiveSession({
      id: 'fresh-2',
      engineVersion: 'v',
      resolve: () => ({
        ok: false,
        problem: {
          type: 'about:blank',
          title: 't',
          status: 404,
          code: 'NOT_FOUND',
          correlationId: 'c',
          retryable: false,
        },
      }),
    });
    const result = acceptHello(
      registry,
      bare,
      hello('sess-1', { '1': 2 }),
      30_001,
    );
    expect(result.session).toBe(bare);
    expect(wire(result.frames)[0]).toMatchObject({
      t: 'welcome',
      session: 'fresh-2',
    });
    // An unknown session id also falls back to the fresh session (here it has already said hello).
    expect(acceptHello(registry, bare, hello('nobody', {}), 1).violation).toBe(
      'hello sent twice',
    );
  });

  it('takes a plain hello without resume as a new session', () => {
    const registry = new ResumeRegistry<LiveSession>();
    const bare = new LiveSession({
      id: 'f',
      engineVersion: 'v',
      resolve: () => ({ ok: true, spec: spec() }),
    });
    const result = acceptHello(registry, bare, { t: 'hello', v: 1 }, 0);
    expect(result.session).toBe(bare);
    expect(result.frames).toHaveLength(1);
  });

  it('refuses to park or resume a session in the wrong state', () => {
    const registry = new ResumeRegistry<LiveSession>();
    const session = lossless();
    expect(() => {
      session.resume({});
    }).toThrow(/cannot resume/);
    session.close();
    expect(() => {
      session.park(registry, 0);
    }).toThrow(/cannot park/);
  });
});
