// Model-based tests (fast-check commands) for the acceptance criteria of the live protocol: a
// random command sequence drives a real session and a tiny model of what the client must see.
import {
  ClientFrameSchema,
  type ClientFrame,
  type ServerFrame,
} from '@app/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ResumeRegistry } from './resume.ts';
import { acceptHello, type LiveSession } from './session.ts';
import { credit, open, spec, sub, wire } from './test-support.ts';

type Frame<T extends ServerFrame['t']> = Extract<ServerFrame, { t: T }>;

describe('AC-1 lossless overflow', () => {
  it('AC-1 a lossless outbox that overflows sends a gap, then a snapshot, and drops nothing silently', () => {
    const source: number[] = [];
    const session = open({
      'l.t': spec({
        ring: { items: 3, bytes: 100 },
        snapshot: () => ({ value: [...source], bytes: source.length }),
      }),
    });
    session.receive(sub(1, 'l.t', 0));
    for (let v = 1; v <= 5; v++) {
      source.push(v);
      session.publish(1, { value: v, bytes: 1 });
    }
    session.receive(credit(1, 2));
    expect(wire(session.drain(0).frames)).toEqual([
      { t: 'gap', sid: 1, fromSeq: 1, toSeq: 5, reason: 'overflow' },
      { t: 'snapshot', sid: 1, seq: 5, items: [1, 2, 3, 4, 5] },
    ]);
    expect(session.inspect(1)?.credits).toBe(1);
  });

  /** The real session and, next to it, what the client has been told so far. */
  interface State {
    session: LiveSession;
    registry: ResumeRegistry<LiveSession>;
    /** The topic's truth: item n has value n and seq n. */
    source: number[];
    /** Frames the client received, in order. */
    frames: ServerFrame[];
    now: number;
    credits: number;
  }
  type Cmd = fc.Command<State, State>;

  function lastSeen(s: State): number {
    const seen = s.frames.filter((f) => f.t === 'data' || f.t === 'snapshot');
    const last = seen.at(-1);
    return last !== undefined && 'seq' in last ? last.seq : 0;
  }

  class Publish implements Cmd {
    readonly bytes: number;
    constructor(bytes: number) {
      this.bytes = bytes;
    }
    check = (): boolean => true;
    run(s: State): void {
      s.source.push(s.source.length + 1);
      s.session.publish(1, { value: s.source.length, bytes: this.bytes });
    }
    toString = (): string => `publish(${String(this.bytes)} bytes)`;
  }
  class Grant implements Cmd {
    readonly n: number;
    constructor(n: number) {
      this.n = n;
    }
    check = (): boolean => true;
    run(s: State): void {
      s.session.receive(credit(1, this.n));
      s.credits += this.n;
    }
    toString = (): string => `grant(${String(this.n)})`;
  }
  class Drain implements Cmd {
    check = (): boolean => true;
    run(s: State): void {
      s.now += 7;
      const { frames } = s.session.drain(s.now);
      s.credits -= frames.filter(
        (f) => f.t === 'data' || f.t === 'snapshot',
      ).length;
      s.frames.push(...wire(frames));
      expect(s.credits).toBeGreaterThanOrEqual(0);
      expect(s.session.inspect(1)?.credits).toBe(s.credits);
    }
    toString = (): string => 'drain';
  }
  /**
   * Transport loss: the last `lose` data frames never arrive, `down` items are published while
   * the session is parked, then the client resumes.
   */
  class Reconnect implements Cmd {
    readonly lose: number;
    readonly down: number;
    constructor(lose: number, down: number) {
      this.lose = lose;
      this.down = down;
    }
    check = (): boolean => true;
    run(s: State): void {
      for (let i = 0; i < this.lose; i++) {
        if (s.frames.at(-1)?.t === 'data') s.frames.pop();
      }
      const seq = lastSeen(s);
      s.session.park(s.registry, s.now);
      for (let i = 0; i < this.down; i++) {
        s.source.push(s.source.length + 1);
        s.session.publish(1, { value: s.source.length, bytes: 1 });
      }
      s.now += 20_000;
      const hello = ClientFrameSchema.parse({
        t: 'hello',
        v: 1,
        resume: { session: s.session.id, lastSeq: { '1': seq } },
      }) as Extract<ClientFrame, { t: 'hello' }>;
      const result = acceptHello(
        s.registry,
        open({}, undefined, 'x'),
        hello,
        s.now,
      );
      expect(result.session).toBe(s.session);
      s.frames.push(...wire(result.frames));
      s.credits = 0;
    }
    toString = (): string =>
      `reconnect(lose ${String(this.lose)}, down ${String(this.down)})`;
  }

  /** Every seq is delivered or inside a gap that a snapshot follows at once. */
  function assertNothingSilent(s: State): void {
    let expected = 1;
    let gapEnd: number | null = null;
    for (const f of s.frames) {
      if (!('sid' in f) || f.sid !== 1) continue;
      if (gapEnd !== null) {
        if (f.t !== 'snapshot') {
          throw new Error('a gap must be followed by a snapshot');
        }
        expect(f.seq).toBe(gapEnd);
        expect(f.items).toEqual(Array.from({ length: f.seq }, (_, i) => i + 1));
        expected = f.seq + 1;
        gapEnd = null;
      } else if (f.t === 'data') {
        const start = f.seq - f.items.length + 1;
        expect(start).toBe(expected);
        expect(f.items).toEqual(
          Array.from({ length: f.items.length }, (_, i) => start + i),
        );
        expected = f.seq + 1;
      } else if (f.t === 'gap') {
        expect(f.fromSeq).toBe(expected);
        expect(f.toSeq).toBeGreaterThanOrEqual(f.fromSeq);
        gapEnd = f.toSeq;
      } else if (f.t === 'snapshot') {
        throw new Error('a lossless topic only snapshots after a gap');
      }
    }
    expect(gapEnd).toBeNull();
    expect(expected).toBe(s.source.length + 1);
  }

  it('AC-1 holds for random command sequences, including resume with lost frames', () => {
    const commands = fc.commands(
      [
        fc.integer({ min: 1, max: 30 }).map((b) => new Publish(b)),
        fc.integer({ min: 1, max: 3 }).map((n) => new Grant(n)),
        fc.constant(new Drain()),
        fc
          .tuple(fc.integer({ min: 0, max: 2 }), fc.integer({ min: 0, max: 6 }))
          .map(([lose, down]) => new Reconnect(lose, down)),
      ],
      { maxCommands: 60 },
    );
    let overflows = 0;
    let resumedGaps = 0;
    fc.assert(
      fc.property(commands, (cmds) => {
        const source: number[] = [];
        const session = open({
          'l.t': spec({
            ring: { items: 4, bytes: 40 },
            snapshot: () => ({ value: [...source], bytes: source.length }),
          }),
        });
        session.receive(sub(1, 'l.t', 0));
        const state: State = {
          session,
          registry: new ResumeRegistry(),
          source,
          frames: [],
          now: 0,
          credits: 0,
        };
        fc.modelRun(() => ({ model: state, real: state }), cmds);
        // Let the client catch up completely, then check that nothing went missing.
        session.receive(credit(1, 1000));
        state.frames.push(...wire(session.drain(state.now + 1).frames));
        assertNothingSilent(state);
        for (const f of state.frames) {
          if (f.t === 'gap' && f.reason === 'overflow') overflows += 1;
          if (f.t === 'gap' && f.reason === 'resume-unavailable')
            resumedGaps += 1;
        }
      }),
      { numRuns: 400 },
    );
    // The generator does reach the cases the property is about.
    expect(overflows).toBeGreaterThan(0);
    expect(resumedGaps).toBeGreaterThan(0);
  });
});

describe('AC-2 latest topic with maxHz', () => {
  const latest = (): LiveSession =>
    open({
      'm.l': spec({
        qos: 'latest',
        maxHz: 4,
        ring: { items: 8, bytes: 1024 },
        key: (item) => (item as { k: string }).k,
      }),
    });

  it('AC-2 100 updates of one key in 1 s give at most 4 frames carrying the newest value, credits never negative', () => {
    const session = latest();
    session.receive(sub(1, 'm.l', 100));
    const frames: { at: number; frame: Frame<'data'> }[] = [];
    let wakeAt: number | null = null;
    for (let i = 0; i < 100; i++) {
      const at = i * 10;
      session.publish(1, { value: { k: 'cpu', v: i }, bytes: 8 });
      const drained = session.drain(at);
      wakeAt = drained.wakeAt;
      for (const frame of wire(drained.frames)) {
        if (frame.t === 'data') frames.push({ at, frame });
      }
      expect(session.inspect(1)?.credits).toBeGreaterThanOrEqual(0);
    }
    expect(frames.length).toBeLessThanOrEqual(4);
    expect(frames.map((f) => f.at)).toEqual([0, 250, 500, 750]);
    // Each frame carries exactly the newest value at that moment: 0, 25, 50, 75.
    expect(frames.map((f) => f.frame.items)).toEqual([
      [{ k: 'cpu', v: 0 }],
      [{ k: 'cpu', v: 25 }],
      [{ k: 'cpu', v: 50 }],
      [{ k: 'cpu', v: 75 }],
    ]);
    // The newest value (99) is not lost: it goes out when the next 250 ms slot opens.
    expect(wakeAt).toBe(1000);
    expect(session.drain(999).frames).toEqual([]);
    expect(session.drain(1000).frames).toEqual([
      { t: 'data', sid: 1, seq: 100, items: [{ k: 'cpu', v: 99 }] },
    ]);
    expect(session.inspect(1)?.credits).toBe(100 - 5);
  });

  it('AC-2 with fewer credits than slots it stops at zero and sends the newest value once credit returns', () => {
    const session = latest();
    session.receive(sub(1, 'm.l', 2));
    let sent = 0;
    for (let i = 0; i < 100; i++) {
      session.publish(1, { value: { k: 'cpu', v: i }, bytes: 8 });
      sent += session.drain(i * 10).frames.length;
      expect(session.inspect(1)?.credits).toBeGreaterThanOrEqual(0);
    }
    expect(sent).toBe(2);
    expect(session.inspect(1)).toMatchObject({ credits: 0, items: 1 });
    session.receive(credit(1, 1));
    expect(session.drain(1000).frames).toEqual([
      { t: 'data', sid: 1, seq: 100, items: [{ k: 'cpu', v: 99 }] },
    ]);
  });
});

describe('snapshot-delta convergence (model-based)', () => {
  interface Item {
    k: string;
    v: number;
  }
  interface State {
    session: LiveSession;
    now: number;
    source: Map<string, number>;
    client: Map<string, number>;
    credits: number;
  }
  type Cmd = fc.Command<State, State>;

  function apply(s: State, frames: ServerFrame[]): void {
    for (const f of frames) {
      if (f.t === 'snapshot') {
        s.client = new Map((f.items as Item[]).map((i) => [i.k, i.v]));
      } else if (f.t === 'delta') {
        for (const i of f.upserts as Item[]) s.client.set(i.k, i.v);
        for (const k of f.removes) s.client.delete(k);
      } else continue;
      s.credits -= 1;
    }
  }

  class Upsert implements Cmd {
    readonly k: string;
    readonly v: number;
    constructor(k: string, v: number) {
      this.k = k;
      this.v = v;
    }
    check = (): boolean => true;
    run(s: State): void {
      s.source.set(this.k, this.v);
      s.session.publish(1, { value: { k: this.k, v: this.v }, bytes: 4 });
    }
    toString = (): string => `upsert(${this.k}, ${String(this.v)})`;
  }
  class Remove implements Cmd {
    readonly k: string;
    constructor(k: string) {
      this.k = k;
    }
    check = (): boolean => true;
    run(s: State): void {
      s.source.delete(this.k);
      s.session.publishRemove(1, this.k);
    }
    toString = (): string => `remove(${this.k})`;
  }
  class Grant implements Cmd {
    readonly n: number;
    constructor(n: number) {
      this.n = n;
    }
    check = (): boolean => true;
    run(s: State): void {
      s.session.receive(credit(1, this.n));
      s.credits += this.n;
    }
    toString = (): string => `grant(${String(this.n)})`;
  }
  class Drain implements Cmd {
    check = (): boolean => true;
    run(s: State): void {
      s.now += 3;
      apply(s, wire(s.session.drain(s.now).frames));
      expect(s.credits).toBeGreaterThanOrEqual(0);
      expect(s.session.inspect(1)?.credits).toBe(s.credits);
    }
    toString = (): string => 'drain';
  }

  it('after any sequence the client state equals the source, overflow included', () => {
    const key = fc.constantFrom('a', 'b', 'c', 'd', 'e');
    const commands = fc.commands(
      [
        fc.tuple(key, fc.nat(99)).map(([k, v]) => new Upsert(k, v)),
        key.map((k) => new Remove(k)),
        fc.integer({ min: 1, max: 3 }).map((n) => new Grant(n)),
        fc.constant(new Drain()),
      ],
      { maxCommands: 60 },
    );
    fc.assert(
      fc.property(commands, (cmds) => {
        const source = new Map<string, number>();
        const session = open({
          'w.x': spec({
            qos: 'latest',
            flow: 'snapshot-delta',
            ring: { items: 3, bytes: 100 },
            key: (item) => (item as Item).k,
            snapshot: () => ({
              value: [...source].map(([k, v]) => ({ k, v })),
              bytes: source.size,
            }),
          }),
        });
        session.receive(sub(1, 'w.x', 0));
        const state: State = {
          session,
          now: 0,
          source,
          client: new Map(),
          credits: 0,
        };
        fc.modelRun(() => ({ model: state, real: state }), cmds);
        state.session.receive(credit(1, 1000));
        apply(state, wire(state.session.drain(1_000_000).frames));
        expect(state.client).toEqual(state.source);
      }),
      { numRuns: 300 },
    );
  });
});
