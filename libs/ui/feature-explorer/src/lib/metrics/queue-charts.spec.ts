// M1-54 AC-17 and AC-18: the Charts tab of a queue over the real entity page, the real chart components and the
// model's fake `MetricsData` (history, the live topic and failures a spec controls). Nothing here reaches a real
// engine; the engine-backed record of requests is `explorer-requests.spec.ts` (AC-21).
import {
  eventually,
  restoreGridSpecEnvironment,
  warmUpGrid,
  WARM_UP_TIMEOUT_MS,
} from '@app/ui-grid/testing/components';
import { quietStatus, seriesResult } from '@app/metrics-model/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PAGE_TEST_TIMEOUT_MS } from '../testing/dom';
import {
  allText,
  cards,
  engineProblem,
  live,
  mountQueueMetrics,
  MINUTE,
  NOTHING_REPORTED,
  ORDERS_QUEUE,
  queueHistory,
  T0,
  textOf,
  type MetricsBed,
} from '../testing/metrics-bed';

const flush = async (bed: MetricsBed): Promise<void> => {
  bed.fixture.detectChanges();
  await bed.fixture.whenStable();
  bed.fixture.detectChanges();
};

async function ready(bed: MetricsBed, count = 2): Promise<void> {
  await eventually(() => {
    bed.fixture.detectChanges();
    expect(cards(bed.el)).toHaveLength(count);
    expect(bed.metrics.queries.length).toBeGreaterThan(0);
  }, 8000);
  await flush(bed);
}

const select = (bed: MetricsBed, selector: string, value: string): void => {
  const element = bed.el.querySelector<HTMLSelectElement>(selector);
  if (element === null) throw new Error(`no ${selector}`);
  element.value = value;
  element.dispatchEvent(new Event('change', { bubbles: true }));
};

/** The depth chart's keyboard cursor, moved to the newest point, as the screen reader hears it. */
async function newest(bed: MetricsBed): Promise<string> {
  const plot = cards(bed.el)[0]?.plot;
  if (!plot) throw new Error('no plot');
  plot.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'End',
      bubbles: true,
      cancelable: true,
    }),
  );
  await flush(bed);
  return plot.getAttribute('aria-valuetext') ?? '';
}

const maxIndex = (bed: MetricsBed): string | null | undefined =>
  cards(bed.el)[0]?.plot?.getAttribute('aria-valuemax');

describe('the Charts tab of a queue', () => {
  beforeAll(warmUpGrid, WARM_UP_TIMEOUT_MS);
  afterAll(restoreGridSpecEnvironment);

  it(
    'M1-54 AC-17 the Charts tab shows history and live points and its controls work',
    async () => {
      const bed = await mountQueueMetrics();
      await ready(bed);

      // The tab is built and selected; the page asks for the queue's series once and follows the live topic once.
      const tab = bed.el.querySelector('[data-tab="charts"]');
      expect(tab?.getAttribute('aria-disabled')).toBeNull();
      expect(tab?.getAttribute('aria-selected')).toBe('true');
      expect(bed.metrics.queries).toHaveLength(1);
      const asked = bed.metrics.queries[0];
      expect(asked).toMatchObject({ cid: 'c1', maxPoints: 720, rate: false });
      expect(asked?.series.map((s) => s.metric)).toEqual([
        'queue_messages_ready',
        'queue_messages_unacked',
        'queue_messages',
        'queue_consumers',
      ]);
      expect(asked?.series.every((s) => s.queue?.name === 'orders')).toBe(true);
      expect(bed.metrics.followers).toHaveLength(1);
      expect(bed.metrics.followers[0]?.params).toEqual({
        cid: 'c1',
        queues: [ORDERS_QUEUE],
      });

      // Two charts: the depth with its three lines, and the consumers.
      const shown = cards(bed.el);
      expect(shown.map((c) => c.title)).toEqual([
        'Queue depth',
        'Queue consumers',
      ]);
      expect(shown[0]?.paths).toHaveLength(3);
      expect(shown[0]?.legend.join(' ')).toContain('Ready');
      expect(shown[0]?.legend.join(' ')).toContain('Unacknowledged');
      expect(shown[1]?.paths).toHaveLength(1);
      // The default range is 15 minutes: of 20 points a minute apart, the last 16.
      expect(maxIndex(bed)).toBe('15');
      expect(await newest(bed)).toContain('Ready: 95');

      // A new point arrives on the live topic and is the newest value on the chart.
      bed.metrics.emit({
        kind: 'delta',
        upserts: [
          live('queue_messages_ready', T0 + 20 * MINUTE, 100),
          live('queue_messages_unacked', T0 + 20 * MINUTE, 1),
          live('queue_messages', T0 + 20 * MINUTE, 101),
        ],
        removes: [],
      });
      await flush(bed);
      expect(await newest(bed)).toContain('Ready: 100');

      // The range filters what is held and asks for nothing: 5 minutes, 15 minutes, an hour.
      select(bed, 'select.range', '5m');
      await flush(bed);
      expect(maxIndex(bed)).toBe('5');
      select(bed, 'select.range', '1h');
      await flush(bed);
      expect(maxIndex(bed)).toBe('20');
      select(bed, 'select.range', '15m');
      await flush(bed);
      expect(maxIndex(bed)).toBe('15');
      expect(bed.metrics.queries).toHaveLength(1);

      // The vertical scale changes the axis.
      const ticks = (): string[] =>
        allText(cards(bed.el)[0]?.card ?? bed.el, '.tick').filter(
          (t) => !t.includes(':'),
        );
      expect(ticks()).not.toContain('1K');
      select(bed, 'select.scale', 'log');
      await flush(bed);
      expect(ticks()).toContain('1K');
      select(bed, 'select.scale', 'zero');
      await flush(bed);

      // Pause freezes what is shown and counts what waits; resume shows it.
      const pause = bed.el.querySelector<HTMLButtonElement>('button.pause');
      expect(pause?.getAttribute('aria-pressed')).toBe('false');
      pause?.click();
      await flush(bed);
      expect(pause?.getAttribute('aria-pressed')).toBe('true');
      expect(pause?.textContent.trim()).toBe('Resume');
      bed.metrics.emit({
        kind: 'delta',
        upserts: [
          live('queue_messages_ready', T0 + 21 * MINUTE, 120),
          live('queue_messages_unacked', T0 + 21 * MINUTE, 2),
          live('queue_messages', T0 + 21 * MINUTE, 122),
        ],
        removes: [],
      });
      await flush(bed);
      expect(textOf(bed.el, 'app-metrics-charts .state')).toContain(
        '3 new points are waiting',
      );
      expect(await newest(bed)).toContain('Ready: 100');
      pause?.click();
      await flush(bed);
      expect(textOf(bed.el, 'app-metrics-charts .state')).not.toContain(
        'are waiting',
      );
      expect(await newest(bed)).toContain('Ready: 120');

      // Read the history again.
      bed.el.querySelector<HTMLButtonElement>('button.reload')?.click();
      await flush(bed);
      expect(bed.metrics.queries).toHaveLength(2);

      // Leaving the page ends the subscription.
      bed.fixture.destroy();
      expect(bed.metrics.followers[0]?.active).toBe(false);
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'M1-54 AC-18 with no statistics and no Prometheus each chart explains the gap',
    async () => {
      const bed = await mountQueueMetrics({
        configure: (metrics) => {
          metrics.answer = NOTHING_REPORTED;
        },
      });
      await ready(bed);
      // Every chart says so in words, with the engine's reasons, and draws no line at all (never a zero).
      for (const shown of cards(bed.el)) {
        expect(shown.paths).toEqual([]);
        expect(shown.card.querySelector('.gap')?.textContent).toContain(
          'The engine holds none of the series of this chart.',
        );
        expect(
          shown.card.querySelector('[data-code="no-source"]'),
        ).not.toBeNull();
        expect(
          shown.card.querySelector('[data-code="unavailable"]'),
        ).not.toBeNull();
        // Each series is listed as not reported, with its reason.
        expect(
          shown.legend.every((l) =>
            l.includes('not reported (no metrics source)'),
          ),
        ).toBe(true);
        expect(shown.card.querySelector('.empty')?.textContent).toContain(
          'nothing to draw',
        );
        expect(shown.card.querySelector('table')).toBeNull();
      }
      expect(allText(bed.el, 'app-metrics-charts .state .source')).toEqual([
        'Source: none.',
      ]);
      expect(textOf(bed.el, 'app-metrics-charts .state')).toContain(
        'no metric is collected',
      );
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'M1-54 AC-18 a failed read shows the Problem as sent with its hint and a retry; a live end keeps the data',
    async () => {
      const bed = await mountQueueMetrics({
        configure: (metrics) => {
          metrics.failNext(
            engineProblem(
              'BROKER_UNREACHABLE',
              'Broker unreachable',
              'No route to host.',
            ),
          );
        },
      });
      await ready(bed);
      const alert = bed.el.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain('The metrics could not be read.');
      expect(alert?.textContent).toContain('Broker unreachable');
      expect(alert?.textContent).toContain('No route to host.');
      expect(alert?.querySelector('.hint')).not.toBeNull();
      // Nothing is drawn as zero while the read failed.
      expect(cards(bed.el).every((c) => c.paths.length === 0)).toBe(true);
      // Try again: the history comes, the alert goes, the lines are drawn.
      alert?.querySelector<HTMLButtonElement>('button.retry')?.click();
      await eventually(() => {
        bed.fixture.detectChanges();
        expect(bed.el.querySelector('[role="alert"]')).toBeNull();
        expect(cards(bed.el)[0]?.paths).toHaveLength(3);
      }, 8000);
      // The live topic ends with a Problem: its words are shown and the charts keep their points.
      bed.metrics.emit({
        kind: 'error',
        error: engineProblem(
          'INTERNAL',
          'The subscription ended',
          'Engine restarted.',
        ),
      });
      await flush(bed);
      const state = textOf(bed.el, 'app-metrics-charts .state');
      expect(state).toContain(
        'Live updates ended. The charts keep what they hold.',
      );
      expect(state).toContain('The subscription ended');
      expect(state).toContain('Engine restarted.');
      expect(cards(bed.el)[0]?.paths).toHaveLength(3);
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'M1-54 AC-18 stale, fallback, approximate, partial and dropped are each said, and an unknown state is not fine',
    async () => {
      const codes = async (
        patch: Parameters<typeof quietStatus>[0],
      ): Promise<string[]> => {
        const bed = await mountQueueMetrics({
          configure: (metrics) => {
            metrics.answer = (input) => ({
              ...queueHistory()(input),
              status: quietStatus(patch),
            });
          },
        });
        await ready(bed);
        return [
          ...bed.el.querySelectorAll('app-metrics-charts .state .explain'),
        ].map((p) => p.getAttribute('data-code') ?? '');
      };
      expect(await codes({})).toEqual([]);
      expect(await codes({ state: 'stale', asOf: T0 })).toEqual(['stale']);
      expect(
        await codes({
          source: 'management',
          fallbackReason: 'no-endpoint',
          approximate: true,
          partial: ['per-object-unavailable', 'queue-demand-truncated'],
          dropped: { points: 4, series: 0, samples: 1 },
        }),
      ).toEqual([
        'fallback-no-endpoint',
        'approximate',
        'partial',
        'partial',
        'dropped-points',
        'dropped-samples',
      ]);
      expect(await codes({ state: 'degraded' as never })).toEqual([
        'unknown-state',
      ]);

      // The engine's words, in the person's: a partial reason, a drop count, and "approximate" beside the series.
      const bed = await mountQueueMetrics({
        configure: (metrics) => {
          metrics.answer = (input) => ({
            series: input.series.map((ref) =>
              seriesResult(
                ref,
                [
                  [T0, 5],
                  [T0 + MINUTE, 6],
                ],
                { approximate: true },
              ),
            ),
            status: quietStatus({
              source: 'management',
              approximate: true,
              partial: ['per-object-unavailable'],
              dropped: { points: 4, series: 0, samples: 0 },
            }),
          });
        },
      });
      await ready(bed);
      const state = textOf(bed.el, 'app-metrics-charts .state');
      expect(state).toContain(
        'Per-queue series are not available from this source.',
      );
      expect(state).toContain('4 points were dropped by the engine store.');
      expect(state).toContain('Source: the management API (sampled).');
      expect(cards(bed.el)[0]?.legend.join(' ')).toContain('approximate');
    },
    PAGE_TEST_TIMEOUT_MS,
  );
});
