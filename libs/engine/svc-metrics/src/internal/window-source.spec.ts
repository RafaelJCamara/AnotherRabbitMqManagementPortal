// The source of metrics.live, driven through a real LiveHub on the manual clock of the fakes.
import {
  METRICS_STATUS_KEY,
  metricsLiveTopic,
  type ClientFrame,
  type ServerFrame,
} from '@app/contracts';
import { createTestPrincipal } from '@app/kernel';
import { createTopicRegistry, LiveHub, type TopicSource } from '@app/live';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import type {
  MetricsLiveItemSchema,
  MetricsLiveParamsSchema,
} from '@app/contracts';

import {
  brokerFailure,
  createMetricsFakeDeps,
  type MetricsFakeDeps,
} from '../testing';

import { createLiveSource } from './window-source';

type Item = z.infer<typeof MetricsLiveItemSchema>;
type Params = z.infer<typeof MetricsLiveParamsSchema>;

/** The source as the hub sees it, recording what it publishes. */
function spied(deps: MetricsFakeDeps) {
  const source = createLiveSource(deps);
  const published: Item[] = [];
  const wrapped: TopicSource<Params, Item> = {
    snapshot: (params, who) => source.snapshot(params, who),
    subscribe: (params, who, sink) =>
      source.subscribe(params, who, {
        ...sink,
        publish: (item, bytes) => {
          published.push(item);
          sink.publish(item, bytes);
        },
      }),
  };
  return { source, wrapped, published };
}

function open(deps: MetricsFakeDeps, source: TopicSource<Params, Item>) {
  const topics = createTopicRegistry();
  topics.register(metricsLiveTopic, source);
  const hub = new LiveHub({
    engineVersion: 'test',
    topics,
    canSubscribe: () => true,
    clock: deps.clock,
    timers: deps.timers,
    validateItems: true,
  });
  const client = (principal = createTestPrincipal()) => {
    const sent: ServerFrame[] = [];
    const link = hub.attach(
      {
        send: (text) => {
          sent.push(JSON.parse(text) as ServerFrame);
        },
        close: () => undefined,
        bufferedAmount: 0,
      },
      principal,
    );
    return {
      take: () => sent.splice(0),
      say: async (frame: ClientFrame) => {
        link?.receive(JSON.stringify(frame));
        await deps.timers.settle();
      },
    };
  };
  return { hub, client };
}

const hello: ClientFrame = { t: 'hello', v: 1 };
const sub = (params: unknown, sid = 1): ClientFrame => ({
  t: 'sub',
  sid,
  topic: metricsLiveTopic.id,
  params,
  credit: 100,
});
const watch = (queues: { vhost: string; name: string }[] = []) => ({
  cid: 'c1',
  queues,
});

const itemsOf = (frames: ServerFrame[]): Item[] =>
  frames.flatMap((frame) =>
    frame.t === 'snapshot'
      ? (frame.items as Item[])
      : frame.t === 'delta'
        ? (frame.upserts as Item[])
        : [],
  );
const problemOf = (frames: ServerFrame[]) =>
  frames.flatMap((f) => (f.t === 'end' && f.problem ? [f.problem] : []))[0];
const metricsOf = (items: Item[]) => items.map((i) => i.ref?.metric ?? i.key);

describe('metrics.live source', () => {
  it('AC-17 a subscriber gets the newest point of every cluster and node series and the status, then only what is newer', async () => {
    const deps = createMetricsFakeDeps();
    const started = deps.clock.now();
    const spy = spied(deps);
    const { client } = open(deps, spy.wrapped);
    const c = client();
    await c.say(hello);
    await c.say(sub(watch()));
    await deps.timers.advance(1_000);

    const first = itemsOf(c.take());
    const metrics = metricsOf(first);
    expect(metrics).toContain('messages_ready');
    expect(metrics).toContain('memory_bytes');
    expect(metrics).toContain(METRICS_STATUS_KEY);
    const status = first.find(
      (item) => item.key === METRICS_STATUS_KEY,
    )?.status;
    expect(status).toMatchObject({ state: 'live', source: 'prometheus' });
    const ready = first.find((item) => item.ref?.metric === 'messages_ready');
    expect(ready).toMatchObject({
      v: 990,
      approximate: false,
      t: started,
    });
    // No queue series: nobody named a queue.
    expect(first.some((item) => item.ref?.queue !== undefined)).toBe(false);

    // A round that stored nothing (the endpoint is down) publishes no series: nothing is newer.
    spy.published.length = 0;
    deps.promScript.intercept = () => brokerFailure(503);
    await deps.timers.advance(15_000);
    expect(spy.published.filter((item) => item.ref !== undefined)).toEqual([]);

    // The endpoint comes back: every series moved, so every series is published again.
    deps.promScript.intercept = undefined;
    spy.published.length = 0;
    await deps.timers.advance(15_000);
    const again = spy.published.filter((item) => item.ref !== undefined);
    expect(again.map((item) => item.ref?.metric)).toContain('messages_ready');
    // One round, one timestamp, later than the first.
    expect(new Set(again.map((item) => item.t))).toEqual(
      new Set([started + 30_000]),
    );
  });

  it('AC-17 only the queues named in the subscription are followed', async () => {
    const deps = createMetricsFakeDeps();
    const { client } = open(deps, spied(deps).wrapped);
    const c = client();
    await c.say(hello);
    await c.say(sub(watch([{ vhost: '/', name: 'orders' }])));
    await deps.timers.advance(1_000);
    const queues = itemsOf(c.take()).filter(
      (item) => item.ref?.queue !== undefined,
    );
    expect(new Set(queues.map((item) => item.ref?.queue?.name))).toEqual(
      new Set(['orders']),
    );
    expect(queues.map((item) => item.ref?.metric).sort()).toEqual([
      'queue_consumers',
      'queue_messages',
      'queue_messages_ready',
      'queue_messages_unacked',
    ]);
  });

  it('AC-17 an unknown or foreign connection ends with NOT_FOUND and nothing is collected', async () => {
    const mine = createMetricsFakeDeps();
    const a = open(mine, spied(mine).wrapped).client();
    await a.say(hello);
    await a.say(sub({ cid: 'c9', queues: [] }));
    await mine.timers.advance(1_000);
    expect(problemOf(a.take())).toMatchObject({ code: 'NOT_FOUND' });

    const theirs = createMetricsFakeDeps({ ownerId: 'someone-else' });
    const b = open(theirs, spied(theirs).wrapped).client();
    await b.say(hello);
    await b.say(sub(watch()));
    await theirs.timers.advance(60_000);
    const frames = b.take();
    expect(problemOf(frames)).toMatchObject({ code: 'NOT_FOUND' });
    expect(itemsOf(frames)).toEqual([]);
    expect(theirs.promScript.requests).toHaveLength(0);
    expect(theirs.mgmtScript.paths).toHaveLength(0);
  });

  it('AC-17 an unsubscribe stops the following; a stop ends every subscription and refuses new ones', async () => {
    const deps = createMetricsFakeDeps();
    const spy = spied(deps);
    const { client } = open(deps, spy.wrapped);
    const c = client();
    await c.say(hello);
    await c.say(sub(watch()));
    await deps.timers.advance(1_000);
    c.take();
    await c.say({ t: 'unsub', sid: 1 });
    spy.published.length = 0;
    await deps.timers.advance(15_000);
    expect(spy.published).toEqual([]);

    await c.say(sub(watch(), 2));
    await deps.timers.advance(1_000);
    c.take();
    spy.source.stop();
    await deps.timers.advance(1_000);
    expect(problemOf(c.take())).toMatchObject({ code: 'ENGINE_SHUTTING_DOWN' });
    await c.say(sub(watch(), 3));
    await deps.timers.advance(1_000);
    expect(problemOf(c.take())).toMatchObject({ code: 'ENGINE_SHUTTING_DOWN' });
  });

  it('AC-17 the snapshot of a principal that was not admitted is empty', () => {
    const deps = createMetricsFakeDeps();
    const { source } = spied(deps);
    expect(
      source.snapshot(watch() as Params, createTestPrincipal()).value,
    ).toEqual([]);
  });
});
