// Test support for the hub specs (and the transport integration tests). Not exported from the
// library: a fake transport, a controllable topic source and the topics the specs use.
import {
  defineTopic,
  type ClientFrame,
  type ServerFrame,
  type TopicDef,
} from '@app/contracts';
import { createManualClock, createManualTimers } from '@app/kernel';
import type { Principal } from '@app/ports';
import { z } from 'zod';

import { LiveHub, type LiveHubOptions } from './hub.ts';
import type { LiveLink, LiveTransport } from './session.ts';
import {
  createTopicRegistry,
  type TopicRegistry,
  type TopicSink,
  type TopicSource,
} from './topic-registry.ts';

export class FakeTransport implements LiveTransport {
  readonly sent: string[] = [];
  closedWith: { code: number; reason: string } | undefined;
  bufferedAmount = 0;
  send(text: string): void {
    if (this.closedWith !== undefined) throw new Error('closed');
    this.sent.push(text);
  }
  close(code: number, reason: string): void {
    this.closedWith = { code, reason };
  }
  frames(): ServerFrame[] {
    return this.sent.map((text) => JSON.parse(text) as ServerFrame);
  }
  /** The frames sent since the last call. */
  take(): ServerFrame[] {
    return this.sent.splice(0).map((text) => JSON.parse(text) as ServerFrame);
  }
}

export const alice: Principal = {
  kind: 'local-token',
  id: 'alice',
  display: 'Alice',
  roles: [],
  surface: 'ui',
  unattended: false,
};
export const bob: Principal = { ...alice, id: 'bob', display: 'Bob' };

const Item = z.strictObject({ n: z.number().int() });
export type TestItem = z.infer<typeof Item>;

export const lossless = defineTopic({
  id: 'test.lossless',
  params: z.strictObject({}),
  item: Item,
  qos: 'lossless',
  flow: 'credit',
  permission: 'meta.read',
  ring: { items: 4, bytes: 4096 },
});
export const latest = defineTopic({
  id: 'test.latest',
  params: z.strictObject({ name: z.string() }),
  item: Item,
  qos: 'latest',
  flow: 'credit',
  permission: 'meta.read',
  maxHz: 2,
  key: () => 'k',
  ring: { items: 4, bytes: 4096 },
});
export const secret = defineTopic({
  id: 'test.secret',
  params: z.strictObject({}),
  item: Item,
  qos: 'lossless',
  flow: 'credit',
  permission: 'secrets.admin',
  ring: { items: 4, bytes: 4096 },
});

/** A source whose items the test pushes by hand. */
export class TestSource implements TopicSource<unknown, TestItem> {
  readonly sinks: TopicSink<TestItem>[] = [];
  stopped = 0;
  /** What a snapshot returns. */
  state: TestItem[] = [];
  failOnSubscribe = false;
  snapshot(): { value: readonly TestItem[]; bytes: number } {
    return { value: [...this.state], bytes: 16 * this.state.length };
  }
  subscribe(
    _params: unknown,
    _principal: Principal,
    sink: TopicSink<TestItem>,
  ) {
    if (this.failOnSubscribe) throw new Error('boom');
    this.sinks.push(sink);
    return () => {
      this.stopped += 1;
    };
  }
  /** Publishes `n` numbered items to the first subscription. */
  emit(from: number, to: number): void {
    for (let n = from; n <= to; n += 1) this.sinks[0]?.publish({ n }, 16);
  }
}

export interface Fixture {
  readonly hub: LiveHub;
  readonly topics: TopicRegistry;
  readonly source: TestSource;
  readonly clock: ReturnType<typeof createManualClock>;
  readonly timers: ReturnType<typeof createManualTimers>;
  /** Opens a transport, says nothing yet. */
  connect(principal?: Principal): Client;
}

export interface Client {
  readonly transport: FakeTransport;
  readonly link: LiveLink | undefined;
  send(frame: ClientFrame): Promise<void>;
  /** Frames sent by the hub since the last call. */
  take(): ServerFrame[];
}

export function createFixture(
  options: Partial<LiveHubOptions> = {},
  defs: readonly TopicDef[] = [lossless, latest, secret],
): Fixture {
  const clock = createManualClock(1_000_000);
  const timers = createManualTimers(clock);
  const topics = createTopicRegistry();
  const source = new TestSource();
  for (const def of defs) topics.register(def, source);
  const hub = new LiveHub({
    engineVersion: '0.0.0-test',
    topics,
    canSubscribe: (_principal, permission) => permission !== 'secrets.admin',
    clock,
    timers,
    ...options,
  });
  return {
    hub,
    topics,
    source,
    clock,
    timers,
    connect(principal = alice) {
      const transport = new FakeTransport();
      const link = hub.attach(transport, principal);
      return {
        transport,
        link,
        async send(frame) {
          link?.receive(JSON.stringify(frame));
          await timers.settle();
        },
        take: () => transport.take(),
      };
    },
  };
}

export const hello = (resume?: {
  session: string;
  lastSeq: Record<string, number>;
}): ClientFrame => ({
  t: 'hello',
  v: 1,
  ...(resume === undefined ? {} : { resume }),
});

export const sub = (
  sid: number,
  topic: string,
  credit: number,
  params: unknown = {},
): ClientFrame => ({
  t: 'sub',
  sid,
  topic: topic as never,
  params,
  credit,
});
