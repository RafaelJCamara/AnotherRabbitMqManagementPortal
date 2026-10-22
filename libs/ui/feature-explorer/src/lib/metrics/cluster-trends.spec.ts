// M1-54 AC-20: the cluster overview shows the trends of the cluster (backlog, rates, consumers, memory and disk per
// node) as its own lazy section after the overview, and keeps its own behaviour. The page runs over the real overview
// page, the real chart components and the model's fake `MetricsData`.
import {
  eventually,
  restoreGridSpecEnvironment,
  warmUpGrid,
  WARM_UP_TIMEOUT_MS,
} from '@app/ui-grid/testing/components';
import {
  createFakeMetricsData,
  quietStatus,
  seriesResult,
  type FakeMetricsData,
} from '@app/metrics-model/testing';
import type { MetricsQueryInput } from '@app/metrics-model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OverviewPage } from '../overview/overview.component';
import { PAGE_TEST_TIMEOUT_MS } from '../testing/dom';
import { FakeWorkspace } from '../testing/fake-workspace';
import { cards, MINUTE, T0, textOf } from '../testing/metrics-bed';
import { ManualTimer } from '../testing/manual-timer';
import { mountPage } from '../testing/page-testbed';
import { EXPLORER_TIMER } from '../timer';
import { METRICS_DATA } from './metrics-data';

const overviewOf = (nodes: string[]) => ({
  product: 'RabbitMQ',
  version: '4.3.6',
  totals: { queues: 12, consumers: 5 },
  rates: { state: 'unavailable', reason: 'not-reported' },
  nodes: nodes.map((name) => ({ name, running: true })),
  alarms: { state: 'none' },
  freshness: {
    state: 'live',
    complete: true,
    loaded: 12,
    truncated: false,
    dropped: 0,
    hazards: [],
    versionChanged: false,
  },
});

/** Twenty points a minute apart; a counter grows by 100 a minute (1.67 a second), a gauge counts up. */
const history = (input: MetricsQueryInput) => ({
  series: input.series.map((ref) => {
    const counter = ref.metric.endsWith('_total');
    return seriesResult(
      ref,
      Array.from(
        { length: 20 },
        (_, i) => [T0 + i * MINUTE, counter ? i * 100 : i] as const,
      ),
      { kind: counter ? 'counter' : 'gauge' },
    );
  }),
  status: quietStatus({ asOf: T0 + 19 * MINUTE }),
});

async function open(nodes: string[], metrics: FakeMetricsData) {
  const workspace = new FakeWorkspace();
  workspace.overview = () => overviewOf(nodes);
  const bed = await mountPage(OverviewPage, {
    workspace,
    providers: [{ provide: METRICS_DATA, useValue: metrics }],
  });
  await eventually(() => {
    bed.fixture.detectChanges();
    expect(cards(bed.el)).toHaveLength(5);
  }, 8000);
  bed.fixture.detectChanges();
  return bed;
}

describe('the trends of the cluster overview', () => {
  beforeAll(warmUpGrid, WARM_UP_TIMEOUT_MS);
  afterAll(restoreGridSpecEnvironment);

  it(
    'M1-54 AC-20 the overview shows the cluster trends and keeps its own behaviour',
    async () => {
      const metrics = createFakeMetricsData();
      metrics.answer = history;
      const bed = await open(['rabbit@b', 'rabbit@a'], metrics);

      // One read for the cluster's series (18 of at most 50, raw counters, no queue) and one subscription with no queue.
      expect(metrics.queries).toHaveLength(1);
      const asked = metrics.queries[0];
      expect(asked?.series).toHaveLength(18);
      expect(asked?.rate).toBe(false);
      expect(asked?.series.some((s) => s.queue !== undefined)).toBe(false);
      expect(metrics.followers[0]?.params).toEqual({ cid: 'c1', queues: [] });
      expect(metrics.forecasts[0]?.target).toEqual({ scope: 'cluster' });

      // A chart per group, memory and disk named by the overview's nodes (in name order), the trends after the rest.
      const shown = cards(bed.el);
      expect(shown.map((c) => c.title)).toEqual([
        'Message backlog',
        'Message rates',
        'Consumers, channels and connections',
        'Memory by node',
        'Free disk by node',
      ]);
      expect(shown[3]?.legend.join('|')).toContain('Memory used (rabbit@a)');
      expect(shown[3]?.legend.join('|')).toContain('Memory limit (rabbit@b)');
      expect(shown[0]?.paths).toHaveLength(3);
      expect(shown[1]?.paths).toHaveLength(4);
      // Counters are drawn as per-second rates: 100 a minute is 1.67 a second.
      const plot = shown[1]?.plot;
      plot?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
      );
      bed.fixture.detectChanges();
      expect(plot?.getAttribute('aria-valuetext')).toContain(
        'Published: 1.67/s',
      );
      // The overview keeps what it had, and the trends come last.
      expect(bed.el.querySelectorAll('.region').length).toBeGreaterThanOrEqual(
        5,
      );
      const children = [...(bed.el.querySelector('.page')?.children ?? [])];
      expect(children.at(-1)?.tagName.toLowerCase()).toBe('app-metrics-charts');
      expect(textOf(bed.el, 'app-metrics-charts h2')).toBe('Trends');
      expect(bed.el.querySelector('h1')?.textContent.trim()).toBe(
        'Cluster overview',
      );
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'M1-54 AC-20 a refresh of the overview does not restart the trends, and no nodes say memory and disk have nothing to chart',
    async () => {
      const metrics = createFakeMetricsData();
      metrics.answer = history;
      const none = await open([], metrics);
      const [, , , memory, disk] = cards(none.el);
      for (const card of [memory, disk]) {
        expect(card?.card.textContent).toContain(
          'No node names are known yet, so memory and disk have nothing to chart.',
        );
        expect(card?.paths).toEqual([]);
      }
      // Only the three chart groups that do not need nodes are queried: 10 series.
      expect(metrics.queries[0]?.series).toHaveLength(10);

      // Same nodes, read again after the floor of the overview: the session is the same (no new query or subscription).
      const again = createFakeMetricsData();
      again.answer = history;
      const timer = new ManualTimer();
      const workspace = new FakeWorkspace();
      workspace.overview = () => overviewOf(['rabbit@a']);
      const bed = await mountPage(OverviewPage, {
        workspace,
        providers: [
          { provide: METRICS_DATA, useValue: again },
          { provide: EXPLORER_TIMER, useValue: timer },
        ],
      });
      await eventually(() => {
        bed.fixture.detectChanges();
        expect(cards(bed.el)).toHaveLength(5);
      }, 8000);
      const reads = again.queries.length;
      timer.advance(10_000);
      bed.fixture.detectChanges();
      bed.el.querySelector<HTMLButtonElement>('button.refresh')?.click();
      await eventually(() => {
        expect(
          workspace.requestLines.filter((l) => l.includes('/overview')),
        ).toHaveLength(2);
      });
      bed.fixture.detectChanges();
      await bed.fixture.whenStable();
      expect(again.queries).toHaveLength(reads);
      expect(again.followers.filter((f) => f.active)).toHaveLength(1);
    },
    PAGE_TEST_TIMEOUT_MS,
  );
});
