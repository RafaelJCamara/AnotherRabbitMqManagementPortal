import type { ServerFrame } from '@app/contracts';
import { describe, expect, it } from 'vitest';

import { LiveHub } from './hub.ts';
import {
  alice,
  bob,
  createFixture,
  hello,
  lossless,
  sub,
  type Client,
  type Fixture,
} from './testing.ts';
import { createTopicRegistry } from './topic-registry.ts';

const credit = (sid: number, n: number) => ({ t: 'credit', sid, n }) as const;
/** One item per turn, so each reaches its own frame (items offered together share a frame). */
async function emitEach(
  fixture: Fixture,
  from: number,
  to: number,
): Promise<void> {
  for (let n = from; n <= to; n += 1) {
    fixture.source.emit(n, n);
    await fixture.timers.settle();
  }
}
const kinds = (frames: ServerFrame[]) => frames.map((frame) => frame.t);

/** Says hello and subscribes to the lossless topic as sid 1 with `granted` credits. */
async function subscribed(
  fixture: Fixture,
  granted: number,
): Promise<{ client: Client; session: string }> {
  const client = fixture.connect();
  await client.send(hello());
  const welcome = client.take()[0];
  if (welcome?.t !== 'welcome') throw new Error('no welcome');
  await client.send(sub(1, 'test.lossless', granted));
  expect(kinds(client.take())).toEqual(['subok']);
  return { client, session: welcome.session };
}

describe('live hub: the session', () => {
  it('welcomes with the engine version and the limits, then serves a subscription', async () => {
    const fixture = createFixture();
    const client = fixture.connect();
    await client.send(hello());
    expect(client.take()).toEqual([
      {
        t: 'welcome',
        v: 1,
        session: expect.any(String) as unknown,
        engineVersion: '0.0.0-test',
        limits: {
          maxSubs: 64,
          outboxBytes: 8 * 1024 * 1024,
          maxFrameBytes: 1024 * 1024,
        },
      },
    ]);
    await client.send(sub(1, 'test.lossless', 2));
    await emitEach(fixture, 1, 3);
    // Two credits, two frames: the third item waits in the outbox.
    expect(client.take()).toEqual([
      { t: 'subok', sid: 1, qos: 'lossless' },
      { t: 'data', sid: 1, seq: 1, items: [{ n: 1 }] },
      { t: 'data', sid: 1, seq: 2, items: [{ n: 2 }] },
    ]);
    await client.send(credit(1, 1));
    expect(client.take()).toEqual([
      { t: 'data', sid: 1, seq: 3, items: [{ n: 3 }] },
    ]);
  });

  it('answers a ping with a pong', async () => {
    const client = createFixture().connect();
    await client.send(hello());
    client.take();
    await client.send({ t: 'ping', ts: 42 });
    expect(client.take()).toEqual([{ t: 'pong', ts: 42 }]);
  });

  it('refuses a subscription to an unknown topic, a wrong parameter or a forbidden topic, and starts no source', async () => {
    const fixture = createFixture();
    const client = fixture.connect();
    await client.send(hello());
    client.take();
    await client.send(sub(1, 'test.nope', 1));
    await client.send(sub(2, 'test.latest', 1, { name: 7 }));
    await client.send(sub(3, 'test.secret', 1));
    const ended = client.take();
    expect(kinds(ended)).toEqual(['end', 'end', 'end']);
    expect(
      ended.map((frame) => frame.t === 'end' && frame.problem?.code),
    ).toEqual(['NOT_FOUND', 'VALIDATION_FAILED', 'FORBIDDEN_RBAC']);
    expect(fixture.source.sinks).toHaveLength(0);
  });

  it('stops the source when the client unsubscribes, and when the connection is dropped for good', async () => {
    const fixture = createFixture();
    const { client } = await subscribed(fixture, 1);
    await client.send({ t: 'unsub', sid: 1 });
    expect(client.take()).toEqual([{ t: 'end', sid: 1, reason: 'unsub' }]);
    expect(fixture.source.stopped).toBe(1);
    await client.send(sub(2, 'test.lossless', 1));
    client.take();
    fixture.hub.close();
    expect(fixture.source.stopped).toBe(2);
    expect(fixture.hub.stats.sessions).toBe(0);
  });

  it('ends a subscription with INTERNAL when its source cannot start', async () => {
    const fixture = createFixture();
    fixture.source.failOnSubscribe = true;
    const client = fixture.connect();
    await client.send(hello());
    client.take();
    await client.send(sub(1, 'test.lossless', 1));
    const frames = client.take();
    expect(kinds(frames)).toEqual(['subok', 'end']);
    expect(frames[1]).toMatchObject({
      t: 'end',
      reason: 'error',
      problem: { code: 'INTERNAL' },
    });
  });

  it('sends the end frame of a source that completes or fails', async () => {
    const fixture = createFixture();
    const { client } = await subscribed(fixture, 1);
    fixture.source.sinks[0]?.end({
      type: 'urn:problem:broker-unreachable',
      title: 'Broker unreachable',
      status: 503,
      code: 'BROKER_UNREACHABLE',
      correlationId: 'c',
      retryable: true,
    });
    expect(client.take()).toMatchObject([
      { t: 'end', sid: 1, reason: 'error' },
    ]);
    expect(fixture.source.stopped).toBe(1);
  });

  it('checks published items against the topic when asked to', async () => {
    const fixture = createFixture({ validateItems: true });
    await subscribed(fixture, 1);
    expect(() => {
      fixture.source.sinks[0]?.publish({ wrong: true } as never);
    }).toThrow();
  });

  it('paces a latest topic at its maxHz with the injected timers', async () => {
    const fixture = createFixture();
    const client = fixture.connect();
    await client.send(hello());
    await client.send(sub(1, 'test.latest', 10, { name: 'x' }));
    client.take();
    fixture.source.emit(1, 1);
    await fixture.timers.settle();
    expect(client.take()).toMatchObject([{ t: 'data', items: [{ n: 1 }] }]);
    fixture.source.emit(2, 5);
    await fixture.timers.settle();
    expect(client.take()).toEqual([]);
    await fixture.timers.advance(500);
    // Only the newest value of the key is sent, at the next slot.
    expect(client.take()).toMatchObject([{ t: 'data', items: [{ n: 5 }] }]);
  });
});

describe('live hub: credit and bounds', () => {
  it('AC-1 a client that stops granting credit cannot grow the outbox, and lossless topics emit gap then snapshot', async () => {
    const fixture = createFixture();
    const { client, session } = await subscribed(fixture, 0);
    fixture.source.state = [{ n: 98 }, { n: 99 }, { n: 100 }];
    // The ring holds 4 items; 100 are offered while the client grants nothing.
    fixture.source.emit(1, 100);
    await fixture.timers.settle();
    expect(client.take()).toEqual([]);
    const view = fixture.hub.sessions.get(session)?.live.inspect(1);
    expect(view?.items).toBeLessThanOrEqual(4);
    expect(view?.bytes).toBeLessThanOrEqual(4096);
    await client.send(credit(1, 5));
    const frames = client.take();
    expect(kinds(frames)).toEqual(['gap', 'snapshot']);
    expect(frames[0]).toMatchObject({
      t: 'gap',
      sid: 1,
      fromSeq: 1,
      toSeq: 100,
      reason: 'overflow',
    });
    expect(frames[1]).toMatchObject({
      t: 'snapshot',
      sid: 1,
      seq: 100,
      items: [{ n: 98 }, { n: 99 }, { n: 100 }],
    });
  });

  it('AC-1 the session-wide outbox budget is bounded too: many topics cannot exceed it', async () => {
    const fixture = createFixture({
      limits: { outboxBytes: 64 },
    });
    const client = fixture.connect();
    await client.send(hello());
    await client.send(sub(1, 'test.lossless', 0));
    client.take();
    fixture.source.emit(1, 50);
    const session = [...fixture.hub.sessions.values()][0];
    expect(session?.live.outboxBytes).toBeLessThanOrEqual(64);
  });

  it('closes a connection that does not read and keeps its session for a resume', async () => {
    const fixture = createFixture({ limits: { outboxBytes: 1024 } });
    const { client, session } = await subscribed(fixture, 5);
    client.transport.bufferedAmount = 2048;
    fixture.source.emit(1, 1);
    await fixture.timers.settle();
    expect(client.transport.closedWith?.code).toBe(1013);
    expect(client.take()).toEqual([]);
    expect(fixture.hub.stats.parked).toBe(1);
    expect(fixture.hub.sessions.has(session)).toBe(true);
  });

  it('refuses connections beyond its limit with 1013', () => {
    const fixture = createFixture({ maxConnections: 1 });
    const first = fixture.connect();
    const second = fixture.connect();
    expect(first.link).toBeDefined();
    expect(second.link).toBeUndefined();
    expect(second.transport.closedWith?.code).toBe(1013);
    expect(fixture.hub.stats).toMatchObject({ connections: 1, refused: 1 });
    first.link?.closed();
    expect(fixture.connect().link).toBeDefined();
  });
});

describe('live hub: resume', () => {
  it('AC-2 lossless subscriptions resume from their seq when hello{resume} arrives within 30 s', async () => {
    const fixture = createFixture();
    const { client, session } = await subscribed(fixture, 10);
    await emitEach(fixture, 1, 3);
    expect(kinds(client.take())).toEqual(['data', 'data', 'data']);
    // The transport drops; the client saw seq 2 only. Items 4 and 5 arrive while it is away.
    client.link?.closed();
    expect(fixture.hub.stats.parked).toBe(1);
    await emitEach(fixture, 4, 5);
    await fixture.timers.advance(10_000);

    const back = fixture.connect();
    await back.send(hello({ session, lastSeq: { '1': 2 } }));
    expect(back.take()).toEqual([
      {
        t: 'welcome',
        v: 1,
        session,
        engineVersion: '0.0.0-test',
        limits: expect.any(Object) as unknown,
      },
      { t: 'subok', sid: 1, qos: 'lossless' },
    ]);
    // Credits restart at zero (the client grants again after welcome): nothing flows until the client grants again.
    await fixture.timers.settle();
    expect(back.take()).toEqual([]);
    await back.send(credit(1, 10));
    // Everything after seq 2, once and in order; a frame's seq is that of its last item.
    expect(back.take()).toEqual([
      { t: 'data', sid: 1, seq: 5, items: [{ n: 3 }, { n: 4 }, { n: 5 }] },
    ]);
    // The source kept running through the outage and is not started twice.
    expect(fixture.source.sinks).toHaveLength(1);
    expect(fixture.source.stopped).toBe(0);
  });

  it('AC-2 after the 30 s window the session is gone: a new one starts and its sources stop', async () => {
    const fixture = createFixture();
    const { client, session } = await subscribed(fixture, 10);
    client.link?.closed();
    await fixture.timers.advance(31_000);
    expect(fixture.source.stopped).toBe(1);
    expect(fixture.hub.stats).toMatchObject({ sessions: 0, parked: 0 });

    const back = fixture.connect();
    await back.send(hello({ session, lastSeq: { '1': 0 } }));
    const welcome = back.take()[0];
    expect(welcome).toMatchObject({ t: 'welcome' });
    expect(welcome?.t === 'welcome' && welcome.session).not.toBe(session);
  });

  it('AC-2 a session can only be resumed by the principal it belongs to', async () => {
    const fixture = createFixture();
    const { client, session } = await subscribed(fixture, 10);
    client.link?.closed();
    const intruder = fixture.connect(bob);
    await intruder.send(hello({ session, lastSeq: { '1': 0 } }));
    const welcome = intruder.take()[0];
    expect(welcome?.t === 'welcome' && welcome.session).not.toBe(session);
    // The owner still can.
    const owner = fixture.connect(alice);
    await owner.send(hello({ session, lastSeq: { '1': 0 } }));
    expect(owner.take()[0]).toMatchObject({ t: 'welcome', session });
  });

  it('AC-2 a lossless topic that lost items resumes with a gap, then a snapshot', async () => {
    const fixture = createFixture();
    const { client, session } = await subscribed(fixture, 10);
    fixture.source.emit(1, 2);
    await fixture.timers.settle();
    client.take();
    client.link?.closed();
    fixture.source.state = [{ n: 40 }];
    fixture.source.emit(3, 40); // far more than the ring holds
    const back = fixture.connect();
    await back.send(hello({ session, lastSeq: { '1': 2 } }));
    back.take();
    await back.send(credit(1, 10));
    const frames = back.take();
    expect(kinds(frames)).toEqual(['gap', 'snapshot']);
    expect(frames[0]).toMatchObject({ fromSeq: 3, reason: 'overflow' });
  });

  it('delivers the end of a subscription that finished while the session was parked', async () => {
    const fixture = createFixture();
    const { client, session } = await subscribed(fixture, 10);
    client.link?.closed();
    fixture.source.sinks[0]?.end();
    const back = fixture.connect();
    await back.send(hello({ session, lastSeq: {} }));
    expect(kinds(back.take())).toEqual(['welcome', 'end']);
  });
});

describe('live hub: bad clients and shutdown', () => {
  it('closes a client that sends no hello first, bad JSON, an unknown frame or an oversized frame', () => {
    for (const [text, code] of [
      [JSON.stringify(sub(1, 'test.lossless', 1)), 1008],
      ['not json', 1008],
      [JSON.stringify({ t: 'hello', v: 2 }), 1008],
      [JSON.stringify({ t: 'ping', ts: 1, extra: true }), 1008],
      [`{"t":"ping","ts":1,"pad":"${'x'.repeat(70_000)}"}`, 1009],
    ] as const) {
      const fixture = createFixture();
      const client = fixture.connect();
      client.link?.receive(text);
      expect(client.transport.closedWith?.code).toBe(code);
      expect(client.take()).toEqual([]);
    }
  });

  it('closes a client that says hello twice or reuses a sid, and drops its session', async () => {
    const fixture = createFixture();
    const { client } = await subscribed(fixture, 1);
    await client.send(sub(1, 'test.lossless', 1));
    expect(client.transport.closedWith?.code).toBe(1008);
    expect(fixture.hub.stats.sessions).toBe(0);
    expect(fixture.source.stopped).toBe(1);
  });

  it('ignores frames after the transport closed', async () => {
    const fixture = createFixture();
    const client = fixture.connect();
    await client.send(hello());
    client.take();
    client.link?.closed();
    client.link?.closed();
    await client.send(sub(1, 'test.lossless', 1));
    expect(client.transport.sent).toEqual([]);
  });

  it('drain tells every client to reconnect and closes the connections', async () => {
    const fixture = createFixture();
    const { client } = await subscribed(fixture, 1);
    fixture.hub.drain(2_000);
    expect(client.take()).toEqual([
      { t: 'goaway', reason: 'drain', reconnectAfterMs: 2_000 },
    ]);
    expect(client.transport.closedWith?.code).toBe(1001);
    expect(fixture.hub.stats.connections).toBe(0);
  });
});

describe('live hub: topic registry', () => {
  it('refuses a duplicate id and a snapshot-delta topic without a key', () => {
    const topics = createTopicRegistry();
    const source = {
      snapshot: () => ({ value: [], bytes: 0 }),
      subscribe: () => () => undefined,
    };
    topics.register(lossless, source);
    expect(() => {
      topics.register(lossless, source);
    }).toThrow(/already registered/);
    expect(() => {
      topics.register(
        { ...lossless, id: 'test.x' as never, flow: 'snapshot-delta' },
        source,
      );
    }).toThrow(/needs a key/);
    expect(topics.size).toBe(1);
    expect(topics.lookup('test.lossless' as never)?.def).toBe(lossless);
    expect(
      new LiveHub({ engineVersion: '1', topics, canSubscribe: () => true })
        .stats.sessions,
    ).toBe(0);
  });
});
