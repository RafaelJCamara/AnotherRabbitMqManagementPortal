// M1-54 AC-19: the Forecast tab of a queue says every state of the engine's forecast in words, draws the overlay for an
// expected time only, never invents one, and reads on open, on Refresh and every 30 s while not paused (never two
// reads at once). The page runs over the real entity page and the model's fake `MetricsData`.
import {
  eventually,
  restoreGridSpecEnvironment,
  warmUpGrid,
  WARM_UP_TIMEOUT_MS,
} from '@app/ui-grid/testing/components';
import type { MetricsForecastOutput } from '@app/metrics-model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PAGE_TEST_TIMEOUT_MS } from '../testing/dom';
import {
  cards,
  engineProblem,
  forecastAnswer,
  mountQueueMetrics,
  textOf,
  type MetricsBed,
} from '../testing/metrics-bed';
import { FORECAST_EVERY_MS } from './forecast-store';

type Forecast = MetricsForecastOutput['forecast'];

const OK: Forecast = {
  state: 'ok',
  etaMs: 600_000,
  band: { lowMs: 500_000, highMs: 700_000 },
  ratePerSec: -2.5,
  r2: 0.974,
  windowMs: 900_000,
  points: 20,
};

async function open(forecast: Forecast): Promise<MetricsBed> {
  const bed = await mountQueueMetrics({
    tab: 'forecast',
    configure: (metrics) => {
      metrics.answerForecast = forecastAnswer(forecast);
    },
  });
  await settle(bed);
  return bed;
}

async function settle(bed: MetricsBed): Promise<void> {
  await eventually(() => {
    bed.fixture.detectChanges();
    expect(bed.metrics.forecasts.length).toBeGreaterThan(0);
    expect(
      bed.el.querySelector('app-forecast-details .sentence'),
    ).not.toBeNull();
  }, 8000);
  bed.fixture.detectChanges();
}

/** Lets the promise chains of a finished read run. */
const quiet = async (): Promise<void> => {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
};

const sentence = (bed: MetricsBed): string =>
  textOf(bed.el, 'app-forecast-details .sentence');

describe('the Forecast tab of a queue', () => {
  beforeAll(warmUpGrid, WARM_UP_TIMEOUT_MS);
  afterAll(restoreGridSpecEnvironment);

  it(
    'M1-54 AC-19 the forecast says every state and never invents an ETA',
    async () => {
      // An expected time with its 95 % band, the numbers it was made from, and the overlay on the depth chart.
      const ok = await open(OK);
      expect(ok.metrics.forecasts[0]).toEqual({
        cid: 'c1',
        target: { scope: 'queue', vhost: '/', name: 'orders' },
      });
      expect(sentence(ok)).toBe(
        'At the current rate the backlog is expected to be empty in about 10 min (95 % band: 8 min 20 sec to 11 min 40 sec).',
      );
      const facts = [
        ...ok.el.querySelectorAll(
          'app-forecast-details dl dt, app-forecast-details dl dd',
        ),
      ].map((n) => n.textContent.trim());
      expect(facts).toEqual([
        'Rate',
        '-2.50/s',
        'Fit (R2)',
        '97 %',
        'Window',
        '15 min',
        'Points',
        '20',
      ]);
      expect(cards(ok.el)).toHaveLength(1);
      expect(cards(ok.el)[0]?.title).toBe('Queue depth');
      expect(ok.el.querySelector('line.drain')).not.toBeNull();
      expect(ok.el.querySelector('.forecast-note')?.textContent).toContain(
        'dashed line',
      );

      // No upper bound says so.
      const open_ = await open({
        ...OK,
        band: { lowMs: 500_000, highMs: null },
      });
      expect(sentence(open_)).toContain(
        'from 8 min 20 sec, with no upper bound',
      );

      // The other states: no ETA, no overlay, the engine's numbers in words.
      const cases: [Forecast, string][] = [
        [
          { state: 'reached' },
          'The backlog is empty: there is nothing to drain.',
        ],
        [
          { state: 'moving-away', ratePerSec: 0.4, r2: 0.99, reason: 'away' },
          'The backlog is growing, so it is moving away from empty.',
        ],
        [
          { state: 'moving-away', ratePerSec: 0, r2: 0.99, reason: 'flat' },
          'The backlog is not shrinking: it is flat.',
        ],
        [
          {
            state: 'moving-away',
            ratePerSec: -0.0001,
            r2: 0.99,
            reason: 'beyond-horizon',
          },
          'shrinking too slowly to be empty within the forecast horizon of 30 days',
        ],
        [
          {
            state: 'no-reliable-forecast',
            r2: 0.41,
            windowMs: 600_000,
            points: 30,
          },
          'No reliable forecast: a straight line explains 41 % of the recent changes, below the 95 % the engine requires. No expected time is shown.',
        ],
        [
          {
            state: 'insufficient-data',
            points: 3,
            spanMs: 30_000,
            needed: { points: 8, spanMs: 60_000 },
          },
          'Not enough data yet: 3 points over 30 sec; the forecast needs 8 points over 1 min.',
        ],
      ];
      for (const [forecast, words] of cases) {
        const bed = await open(forecast);
        expect(sentence(bed), forecast.state).toContain(words);
        expect(sentence(bed)).not.toContain('expected to be empty in about');
        // No overlay, whatever the state.
        expect(bed.el.querySelector('line.drain')).toBeNull();
        expect(bed.el.querySelector('rect.band')).toBeNull();
      }
      // A forecast the engine sent that cannot be trusted is unavailable, not an invented time.
      const bad = await open({
        ...OK,
        band: { lowMs: 650_000, highMs: 700_000 },
      });
      expect(sentence(bad)).toBe('The forecast is unavailable.');
      expect(bad.el.querySelector('line.drain')).toBeNull();
      // A state this version does not know is just as unavailable.
      const future = await open({ state: 'drained-soon' } as never);
      expect(sentence(future)).toBe('The forecast is unavailable.');
    },
    PAGE_TEST_TIMEOUT_MS * 2, // eight pages are mounted one after another
  );

  it(
    'M1-54 AC-19 the forecast is read on open, on Refresh and every 30 s while not paused, never twice at once',
    async () => {
      const bed = await open(OK);
      expect(bed.metrics.forecasts).toHaveLength(1);
      expect(bed.timer.delays).toContain(FORECAST_EVERY_MS);
      // Refresh reads again.
      const refresh = (): void => {
        bed.el
          .querySelector<HTMLButtonElement>(
            'app-forecast-details button.refresh',
          )
          ?.click();
      };
      refresh();
      await eventually(() => {
        expect(bed.metrics.forecasts).toHaveLength(2);
      });
      await quiet();
      // A read in flight is never doubled: Refresh and the clock wait for it.
      const held = bed.metrics.holdForecasts();
      refresh();
      await eventually(() => {
        expect(bed.metrics.forecasts).toHaveLength(3);
      });
      refresh();
      refresh();
      bed.timer.advance(FORECAST_EVERY_MS);
      expect(bed.metrics.forecasts).toHaveLength(3);
      held.release();
      await quiet();
      await eventually(() => {
        bed.fixture.detectChanges();
        expect(
          bed.el.querySelector('app-forecast-details .sentence'),
        ).not.toBeNull();
      });
      // The clock reads again every 30 s, once per tick.
      bed.timer.advance(FORECAST_EVERY_MS);
      await eventually(() => {
        expect(bed.metrics.forecasts).toHaveLength(4);
      });
      await quiet();
      bed.timer.advance(FORECAST_EVERY_MS);
      await eventually(() => {
        expect(bed.metrics.forecasts).toHaveLength(5);
      });
      await quiet();
      // Paused: the tick passes without a read.
      bed.el.querySelector<HTMLButtonElement>('button.pause')?.click();
      bed.fixture.detectChanges();
      bed.timer.advance(FORECAST_EVERY_MS * 2);
      expect(bed.metrics.forecasts).toHaveLength(5);
      // Leaving the page stops the clock: no read after it.
      bed.fixture.destroy();
      bed.timer.advance(FORECAST_EVERY_MS * 3);
      expect(bed.metrics.forecasts).toHaveLength(5);
      expect(bed.timer.pending).toBe(0);
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'M1-54 AC-19 a failed forecast read keeps the last answer, marked as earlier, with the Problem as sent',
    async () => {
      const bed = await open(OK);
      bed.metrics.failNextForecast(
        engineProblem('INTERNAL', 'Forecast failed', 'The store is busy.'),
      );
      bed.el
        .querySelector<HTMLButtonElement>('app-forecast-details button.refresh')
        ?.click();
      await eventually(() => {
        bed.fixture.detectChanges();
        expect(
          bed.el.querySelector('app-forecast-details [role="alert"]'),
        ).not.toBeNull();
      });
      const alert = textOf(bed.el, 'app-forecast-details [role="alert"]');
      expect(alert).toContain('The forecast could not be read.');
      expect(alert).toContain('Forecast failed');
      expect(alert).toContain('The store is busy.');
      // The earlier answer is still on screen, and it says it is earlier.
      expect(sentence(bed)).toContain('about 10 min');
      expect(textOf(bed.el, 'app-forecast-details .earlier')).toBe(
        'This is an earlier answer: the last read failed.',
      );
      // The next read that works clears it.
      bed.el
        .querySelector<HTMLButtonElement>('app-forecast-details button.refresh')
        ?.click();
      await eventually(() => {
        bed.fixture.detectChanges();
        expect(
          bed.el.querySelector('app-forecast-details [role="alert"]'),
        ).toBeNull();
      });
      expect(bed.el.querySelector('app-forecast-details .earlier')).toBeNull();
    },
    PAGE_TEST_TIMEOUT_MS,
  );
});
