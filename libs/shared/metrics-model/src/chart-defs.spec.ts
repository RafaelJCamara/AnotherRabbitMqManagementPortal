import { describe, expect, it } from 'vitest';

import {
  chartData,
  clusterCharts,
  DEFAULT_RANGE,
  domainOf,
  LATER_RANGES,
  MAX_CHART_NODES,
  queueCharts,
  RANGES,
  rangeOf,
  seriesOf,
} from './chart-defs';
import { refKey } from './series-key';

describe('M1-54 chart definitions', () => {
  it('AC-25 the cluster charts name their series, at most 50, counters as rates, the forecast on the backlog', () => {
    const { charts, omittedNodes } = clusterCharts(['b', 'a']);
    expect(omittedNodes).toBe(0);
    expect(charts.map((c) => c.id)).toEqual([
      'backlog',
      'rates',
      'consumers',
      'memory',
      'disk',
    ]);
    // Only counters are drawn as rates; the rates chart is per second.
    const rates = charts.find((c) => c.id === 'rates');
    expect(rates?.unit).toBe('per-second');
    expect(rates?.lines.every((l) => l.rate)).toBe(true);
    expect(
      charts
        .filter((c) => c.id !== 'rates')
        .flatMap((c) => c.lines)
        .some((l) => l.rate),
    ).toBe(false);
    // Memory and disk are per node, in node order, used then limit.
    const memory = charts.find((c) => c.id === 'memory');
    expect(memory?.lines.map((l) => `${l.metric}@${l.node ?? ''}`)).toEqual([
      'memory_bytes@a',
      'memory_bytes@b',
      'memory_limit_bytes@a',
      'memory_limit_bytes@b',
    ]);
    // The forecast hangs on the total of the backlog chart, and on nothing else.
    const anchors = charts.filter((c) => c.forecastAnchor !== null);
    expect(anchors.map((c) => c.id)).toEqual(['backlog']);
    const backlog = anchors[0];
    expect(
      backlog?.lines.find((l) => l.id === backlog.forecastAnchor)?.metric,
    ).toBe('messages');
    // Every line id is the series key and unique inside its chart.
    for (const chart of charts) {
      expect(new Set(chart.lines.map((l) => l.id)).size).toBe(
        chart.lines.length,
      );
      for (const line of chart.lines) expect(line.id).toBe(refKey(line.ref));
    }
    // No nodes: no memory or disk lines, and the charts still exist (the page says why they are empty).
    const none = clusterCharts([]);
    expect(none.charts.find((c) => c.id === 'memory')?.lines).toEqual([]);
  });

  it('AC-25 many nodes are capped so the query stays within 50 series, and the omitted ones are counted', () => {
    const nodes = Array.from({ length: 20 }, (_, i) => `rabbit@n${String(i)}`);
    const { charts, omittedNodes } = clusterCharts(nodes);
    expect(omittedNodes).toBe(20 - MAX_CHART_NODES);
    expect(seriesOf(charts).length).toBeLessThanOrEqual(50);
    // Shared series are asked once.
    const twice = [...charts, ...charts];
    expect(seriesOf(twice)).toEqual(seriesOf(charts));
  });

  it('AC-25 the queue charts are the queue depth with the forecast and its consumers', () => {
    const queue = { vhost: '/', name: 'orders' };
    const charts = queueCharts(queue);
    expect(charts.map((c) => c.id)).toEqual(['queue-depth', 'queue-consumers']);
    expect(charts[0]?.lines.map((l) => l.metric)).toEqual([
      'queue_messages_ready',
      'queue_messages_unacked',
      'queue_messages',
    ]);
    expect(charts[0]?.forecastAnchor).toBe(charts[0]?.lines[2]?.id);
    expect(charts[1]?.forecastAnchor).toBeNull();
    expect(seriesOf(charts).every((r) => r.queue?.name === 'orders')).toBe(
      true,
    );
  });

  it('AC-25 ranges are the hot hour, a longer one is listed for later, and a domain ends at the newest point', () => {
    expect(RANGES.map((r) => r.id)).toEqual(['5m', '15m', '30m', '1h']);
    expect(RANGES.map((r) => r.ms)).toEqual([
      300_000, 900_000, 1_800_000, 3_600_000,
    ]);
    expect(DEFAULT_RANGE).toBe('15m');
    expect(LATER_RANGES).toEqual(['6h', '24h', '7d']);
    expect(rangeOf('1h').ms).toBe(3_600_000);
    expect(rangeOf('nonsense').id).toBe('15m');
    expect(domainOf(10_000_000, 900_000)).toEqual({
      from: 9_100_000,
      to: 10_000_000,
    });
    expect(domainOf(null, 900_000)).toEqual({ from: 0, to: 900_000 });
    // chartData of a session that has not answered is pending, with no points.
    const chart = queueCharts({ vhost: '/', name: 'q' })[0];
    if (chart === undefined) throw new Error('no chart');
    const data = chartData(chart, {
      series: [],
    } as never);
    expect(data.map((d) => d.state)).toEqual(['pending', 'pending', 'pending']);
    expect(data.every((d) => d.points.length === 0)).toBe(true);
  });
});
