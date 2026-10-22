import { describe, expect, it } from 'vitest';

import { chartData, clusterCharts, seriesOf } from './chart-defs';
import type { SeriesRef } from './ports';
import {
  createMetricsSession,
  HISTORY_MAX_POINTS,
  SUMMARY_EVERY_MS,
  type SessionState,
} from './session';
import {
  createFakeMetricsData,
  liveItem,
  quietStatus,
  seriesResult,
  statusItem,
  type FakeMetricsData,
} from './testing';

const READY: SeriesRef = { metric: 'messages_ready' };
const PUBLISHED: SeriesRef = { metric: 'published_total' };
const CONSUMERS: SeriesRef = { metric: 'consumers' };
const CID = 'c1';

/** Lets the promise chains of a read run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
};

function start(
  fake: FakeMetricsData,
  series: readonly SeriesRef[] = [READY, PUBLISHED, CONSUMERS],
) {
  const session = createMetricsSession(fake, { cid: CID, series });
  const seen: SessionState[] = [];
  session.onState((state) => seen.push(state));
  return { session, seen };
}

const times = (state: SessionState, key: number): number[] =>
  (state.series[key]?.points ?? []).map((p) => p.t);

describe('M1-54 metrics session', () => {
  it('AC-8 history and live points join without a seam and a missing series is not zero', async () => {
    const fake = createFakeMetricsData();
    const held = fake.hold();
    fake.answer = (input) => ({
      series: input.series.map((ref) => {
        if (ref.metric === 'messages_ready') {
          return seriesResult(ref, [
            [1000, 10],
            [2000, 20],
            [3000, 30],
          ]);
        }
        if (ref.metric === 'published_total') {
          return seriesResult(
            ref,
            [
              [1000, 100],
              [2000, 200],
              [3000, 300],
            ],
            { kind: 'counter' },
          );
        }
        return seriesResult(ref, null); // consumers: the engine holds no such series
      }),
      status: quietStatus(),
    });
    const { session } = start(fake);
    // One history read: the ask is the three series, raw counters, at most 720 points, the connection.
    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0]).toEqual({
      cid: CID,
      series: [READY, PUBLISHED, CONSUMERS],
      maxPoints: HISTORY_MAX_POINTS,
      rate: false,
    });
    // One subscription, naming no queue (these are cluster series).
    expect(fake.followers).toHaveLength(1);
    expect(fake.followers[0]?.params).toEqual({ cid: CID, queues: [] });

    // The live feed answers before the history does: the newest point of a series waits for it.
    fake.emit({
      kind: 'snapshot',
      items: [
        liveItem(READY, 3000, 30),
        liveItem(READY, 4000, 40),
        liveItem(PUBLISHED, 4000, 400),
        statusItem(quietStatus({ approximate: true })),
      ],
    });
    expect(session.state().phase).toBe('loading');
    expect(session.state().live).toBe('following');
    expect(session.state().series.every((s) => s.points.length === 0)).toBe(
      true,
    );
    held.release();
    await settle();

    // The history first, then the live points newer than it, by time, each point once.
    const state = session.state();
    expect(state.phase).toBe('ready');
    expect(times(state, 0)).toEqual([1000, 2000, 3000, 4000]);
    expect(state.series[0]?.points.map((p) => p.v)).toEqual([10, 20, 30, 40]);
    expect(times(state, 1)).toEqual([1000, 2000, 3000, 4000]);
    expect(state.newestT).toBe(4000);
    // The status of the live topic (newest) is the one shown.
    expect(state.status?.approximate).toBe(true);

    // The series the engine does not hold: not reported, no points at all, never a zero.
    const missing = state.series[2];
    expect(missing?.state).toBe('not-reported');
    expect(missing?.points).toEqual([]);

    // A counter stays raw in the ring; the chart shows its rate, and a reset never gives a negative rate.
    fake.emit({
      kind: 'delta',
      upserts: [
        liveItem(PUBLISHED, 5000, 500),
        liveItem(PUBLISHED, 6000, 20), // the broker restarted: the counter went back
        liveItem(PUBLISHED, 7000, 70),
      ],
      removes: [],
    });
    const after = session.state();
    expect(after.series[1]?.points.map((p) => p.v)).toEqual([
      100, 200, 300, 400, 500, 20, 70,
    ]);
    const { charts } = clusterCharts([]);
    const rateChart = charts.find((c) => c.id === 'rates');
    if (rateChart === undefined) throw new Error('no rates chart');
    const rates = chartData(rateChart, after);
    const published = rates.find((l) => l.def.metric === 'published_total');
    expect(published?.state).toBe('drawn');
    // 100 a second four times, then the reset interval is skipped, then 50 a second.
    expect(published?.points.map((p) => p.v)).toEqual([100, 100, 100, 100, 50]);
    expect(published?.points.every((p) => p.v >= 0)).toBe(true);
    // The other counters of the chart have no series in this session: pending, not drawn.
    expect(rates.find((l) => l.def.metric === 'acked_total')?.points).toEqual(
      [],
    );

    // A series that was not reported draws once a live point arrives for it (a queue after its first round).
    fake.emit({
      kind: 'delta',
      upserts: [liveItem(CONSUMERS, 8000, 3)],
      removes: [],
    });
    expect(session.state().series[2]?.state).toBe('drawn');
    expect(session.state().series[2]?.points).toEqual([{ t: 8000, v: 3 }]);
    // A live item for a series the session did not ask for is ignored.
    fake.emit({
      kind: 'delta',
      upserts: [liveItem({ metric: 'queues' }, 9000, 9)],
      removes: [],
    });
    expect(session.state().series).toHaveLength(3);
    session.destroy();
  });

  it('AC-9 the session says loading, empty, failed, ended, gaps and pauses', async () => {
    // Loading, then empty: the engine answered and holds nothing; its status explains why.
    const quiet = createFakeMetricsData();
    const hold = quiet.hold();
    const first = start(quiet);
    expect(first.session.state()).toMatchObject({
      phase: 'loading',
      live: 'connecting',
      paused: false,
      historyReads: 1,
    });
    hold.release();
    await settle();
    expect(first.session.state().phase).toBe('empty');
    expect(first.session.state().status?.source).toBe('none');
    expect(first.session.state().series.map((s) => s.state)).toEqual([
      'not-reported',
      'not-reported',
      'not-reported',
    ]);
    first.session.destroy();

    // A failed history read keeps the engine's error as received; the live feed still works.
    const broken = createFakeMetricsData();
    const failure = new Error('The broker said no');
    broken.failNext(failure);
    const second = start(broken);
    await settle();
    expect(second.session.state().phase).toBe('error');
    expect(second.session.state().problem).toBe(failure);
    broken.emit({ kind: 'snapshot', items: [liveItem(READY, 1000, 5)] });
    expect(second.session.state().phase).toBe('ready');
    expect(second.session.state().problem).toBe(failure);
    // Reload tries again and clears the failure when it works.
    second.session.reload();
    await settle();
    expect(second.session.state().problem).toBeNull();
    expect(second.session.state().historyReads).toBe(2);

    // The live topic ends with a Problem: the points stay, the Problem is kept as received.
    const ended = new Error('subscription ended');
    broken.emit({ kind: 'error', error: ended });
    expect(second.session.state().live).toBe('ended');
    expect(second.session.state().liveProblem).toBe(ended);
    expect(second.session.state().series[0]?.points).toHaveLength(1);
    expect(second.session.state().phase).toBe('ready');
    second.session.destroy();

    // An end without a Problem.
    const plain = createFakeMetricsData();
    const third = start(plain);
    await settle();
    plain.emit({ kind: 'end' });
    expect(third.session.state()).toMatchObject({
      live: 'ended',
      liveProblem: null,
    });
    third.session.destroy();
  });

  it('AC-9 a gap or a reset asks for the history again, once, and counts it', async () => {
    const fake = createFakeMetricsData();
    const held = fake.hold();
    const { session } = start(fake);
    expect(fake.queries).toHaveLength(1);
    // Two gaps while the first read is in flight cost one more read, not two.
    fake.emit({ kind: 'gap' });
    fake.emit({ kind: 'gap' });
    expect(session.state().gaps).toBe(2);
    expect(fake.queries).toHaveLength(1);
    held.release();
    await settle();
    expect(fake.queries).toHaveLength(2);
    expect(session.state().historyReads).toBe(2);
    // A gap when idle is one read at once; a reset (a new engine session) says it is reconnecting.
    fake.emit({ kind: 'gap' });
    await settle();
    expect(fake.queries).toHaveLength(3);
    fake.emit({ kind: 'snapshot', items: [] });
    expect(session.state().live).toBe('following');
    fake.emit({ kind: 'reset' });
    expect(session.state().live).toBe('connecting');
    await settle();
    expect(fake.queries).toHaveLength(4);
    expect(session.state().gaps).toBe(4);
    // The status event of the live client changes nothing.
    const before = session.state();
    fake.emit({ kind: 'status', state: 'degraded' });
    expect(session.state()).toBe(before);
    session.destroy();
  });

  it('AC-9 a pause freezes what the page shows and counts what waits; resume shows it', async () => {
    const fake = createFakeMetricsData();
    fake.answer = (input) => ({
      series: input.series.map((ref) =>
        seriesResult(ref, ref.metric === 'messages_ready' ? [[1000, 1]] : null),
      ),
      status: quietStatus(),
    });
    const { session, seen } = start(fake);
    await settle();
    session.pause();
    const frozen = session.state().series;
    expect(session.state().paused).toBe(true);
    fake.emit({
      kind: 'delta',
      upserts: [liveItem(READY, 2000, 2), liveItem(READY, 3000, 3)],
      removes: [],
    });
    // The view did not move; the count of waiting points did.
    expect(session.state().series).toBe(frozen);
    expect(times(session.state(), 0)).toEqual([1000]);
    expect(session.state().waiting).toBe(2);
    session.pause(); // a second pause changes nothing
    expect(session.state().waiting).toBe(2);
    session.resume();
    expect(session.state().paused).toBe(false);
    expect(session.state().waiting).toBe(0);
    expect(times(session.state(), 0)).toEqual([1000, 2000, 3000]);
    // The rings were bounded all along and nothing was lost while paused.
    expect(session.state().series[0]?.evicted).toBe(0);
    expect(seen.length).toBeGreaterThan(3);
    session.resume(); // resuming a running session changes nothing
    expect(session.state().paused).toBe(false);
    session.destroy();
  });

  it('AC-9 destroy aborts the read, ends the subscription and silences the session', async () => {
    const fake = createFakeMetricsData();
    const held = fake.hold();
    const { session, seen } = start(fake);
    const count = seen.length;
    session.destroy();
    expect(fake.followers[0]?.active).toBe(false);
    expect(fake.querySignals[0]?.aborted).toBe(true);
    held.release();
    await settle();
    fake.emit({ kind: 'snapshot', items: [liveItem(READY, 1000, 1)] });
    expect(seen).toHaveLength(count);
    expect(session.state().series[0]?.points).toEqual([]);
    session.destroy(); // twice is fine
    session.pause();
    session.reload();
    expect(fake.queries).toHaveLength(1);
  });

  it('AC-9 the summary changes at most once per 15 s of data time unless a state changes', async () => {
    const fake = createFakeMetricsData();
    fake.answer = (input) => ({
      series: input.series.map((ref) => seriesResult(ref, null)),
      status: quietStatus(),
    });
    const { session } = start(fake, [READY]);
    await settle();
    const t0 = 1_000_000;
    fake.emit({ kind: 'snapshot', items: [liveItem(READY, t0, 1)] });
    const first = session.state().summary;
    expect(first.t).toBe(t0);
    expect(Object.values(first.values)).toEqual([1]);
    // Every second for 14 seconds: the same summary object, whatever the values do.
    for (let s = 1; s <= 14; s++) {
      fake.emit({
        kind: 'delta',
        upserts: [liveItem(READY, t0 + s * 1000, 1 + s)],
        removes: [],
      });
      expect(session.state().summary).toBe(first);
    }
    // At 15 s it is renewed, with the newest values.
    fake.emit({
      kind: 'delta',
      upserts: [liveItem(READY, t0 + SUMMARY_EVERY_MS, 99)],
      removes: [],
    });
    const renewed = session.state().summary;
    expect(renewed).not.toBe(first);
    expect(renewed.t).toBe(t0 + SUMMARY_EVERY_MS);
    expect(Object.values(renewed.values)).toEqual([99]);
    // A state that matters changes it at once: a pause, the end of the feed.
    session.pause();
    expect(session.state().summary.paused).toBe(true);
    session.resume();
    fake.emit({ kind: 'end' });
    expect(session.state().summary.live).toBe('ended');
    session.destroy();
  });

  it('AC-8 the session asks for at most 50 series, once each, and names its queues for the live topic', () => {
    const fake = createFakeMetricsData();
    const many = Array.from({ length: 60 }, (_, i) => ({
      metric: 'queue_messages' as const,
      queue: { vhost: '/', name: `q${String(i % 55)}` },
    }));
    const { session } = start(fake, many);
    const asked = fake.queries[0]?.series ?? [];
    expect(asked).toHaveLength(50);
    expect(new Set(asked.map((r) => r.queue?.name)).size).toBe(50);
    expect(fake.followers[0]?.params.queues).toHaveLength(50);
    expect(seriesOf(clusterCharts(['a']).charts).length).toBeLessThanOrEqual(
      50,
    );
    session.destroy();
  });
});
