// A fake `MetricsData` for specs (M1-54): history and forecast answers a spec sets, one controllable live topic,
// failures and held answers, with every call recorded. It is not the engine; a spec that needs the engine uses the
// real actions. Exported as `@app/metrics-model/testing`; never imported by production code.
import { METRICS_STATUS_KEY } from '@app/contracts';

import type {
  LiveFeedEvent,
  LiveItem,
  LiveParams,
  MetricsData,
  MetricsForecastInput,
  MetricsForecastOutput,
  MetricsQueryInput,
  MetricsQueryOutput,
  MetricsStatus,
  SeriesRef,
  SeriesResult,
} from './ports';
import { refKey } from './series-key';

export interface FakeFollower {
  readonly params: LiveParams;
  readonly listener: (event: LiveFeedEvent) => void;
  active: boolean;
}

export interface FakeMetricsData extends MetricsData {
  readonly queries: readonly MetricsQueryInput[];
  readonly querySignals: readonly AbortSignal[];
  readonly forecasts: readonly MetricsForecastInput[];
  readonly followers: readonly FakeFollower[];
  /** What a history read answers; the default says "no series found, loading". */
  answer: (input: MetricsQueryInput) => MetricsQueryOutput;
  /** What a forecast read answers; the default is `insufficient-data`. */
  answerForecast: (input: MetricsForecastInput) => MetricsForecastOutput;
  /** The next history read rejects with this. */
  failNext(error?: unknown): void;
  failNextForecast(error?: unknown): void;
  /** History reads wait until released, in order; `release(n)` answers the first n (all by default). */
  hold(): { release(count?: number): void };
  /** Forecast reads wait until released. */
  holdForecasts(): { release(count?: number): void };
  /** Sends an event to every active follower (or one). */
  emit(event: LiveFeedEvent, follower?: FakeFollower): void;
}

export const quietStatus = (
  patch: Partial<MetricsStatus> = {},
): MetricsStatus => ({
  state: 'live',
  source: 'prometheus',
  asOf: 1_000_000,
  intervalMs: 15_000,
  partial: [],
  approximate: false,
  dropped: { points: 0, series: 0, samples: 0 },
  ...patch,
});

/** A history answer for one series: `points` are `[t, v]`; no points and `found: false` is "not reported". */
export function seriesResult(
  ref: SeriesRef,
  points: readonly (readonly [number, number])[] | null,
  patch: Partial<SeriesResult> = {},
): SeriesResult {
  return points === null
    ? { ref, found: false, view: 'value', points: [], dropped: 0, ...patch }
    : {
        ref,
        found: true,
        kind: 'gauge',
        unit: 'messages',
        source: 'prometheus',
        approximate: false,
        view: 'value',
        points: points.map(([t, v]) => [t, v] as [number, number]),
        dropped: 0,
        ...patch,
      };
}

export const liveItem = (
  ref: SeriesRef,
  t: number,
  v: number,
  approximate = false,
): LiveItem => ({ key: refKey(ref), ref, t, v, approximate });

export const statusItem = (status: MetricsStatus): LiveItem => ({
  key: METRICS_STATUS_KEY,
  status,
});

const NO_ANSWER = (input: MetricsQueryInput): MetricsQueryOutput => ({
  series: input.series.map((ref) => seriesResult(ref, null)),
  status: quietStatus({ state: 'loading', source: 'none' }),
});

const INSUFFICIENT = (input: MetricsForecastInput): MetricsForecastOutput => ({
  target: input.target,
  metric: input.target.scope === 'cluster' ? 'messages' : 'queue_messages',
  forecast: {
    state: 'insufficient-data',
    points: 0,
    spanMs: 0,
    needed: { points: 8, spanMs: 60_000 },
  },
  points: 0,
  status: quietStatus(),
});

function gate() {
  let held = false;
  const waiting: (() => void)[] = [];
  return {
    wait: (): Promise<void> | undefined =>
      held
        ? new Promise<void>((resolve) => {
            waiting.push(resolve);
          })
        : undefined,
    hold: () => {
      held = true;
      return {
        release: (count = waiting.length): void => {
          for (const resolve of waiting.splice(0, count)) resolve();
          if (waiting.length === 0) held = false;
        },
      };
    },
  };
}

export function createFakeMetricsData(): FakeMetricsData {
  const queries: MetricsQueryInput[] = [];
  const querySignals: AbortSignal[] = [];
  const forecasts: MetricsForecastInput[] = [];
  const followers: FakeFollower[] = [];
  const queryGate = gate();
  const forecastGate = gate();
  let failure: { error: unknown } | null = null;
  let forecastFailure: { error: unknown } | null = null;
  const fake: FakeMetricsData = {
    queries,
    querySignals,
    forecasts,
    followers,
    answer: NO_ANSWER,
    answerForecast: INSUFFICIENT,
    async query(input, signal) {
      queries.push(input);
      querySignals.push(signal);
      await queryGate.wait();
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      if (failure !== null) {
        const { error } = failure;
        failure = null;
        throw error;
      }
      return fake.answer(input);
    },
    async forecast(input, signal) {
      forecasts.push(input);
      await forecastGate.wait();
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      if (forecastFailure !== null) {
        const { error } = forecastFailure;
        forecastFailure = null;
        throw error;
      }
      return fake.answerForecast(input);
    },
    follow(params, listener) {
      const follower: FakeFollower = { params, listener, active: true };
      followers.push(follower);
      return () => {
        follower.active = false;
      };
    },
    failNext(error = new Error('the read failed')) {
      failure = { error };
    },
    failNextForecast(error = new Error('the forecast failed')) {
      forecastFailure = { error };
    },
    hold: queryGate.hold,
    holdForecasts: forecastGate.hold,
    emit(event, only) {
      for (const follower of followers) {
        if (follower.active && (only === undefined || only === follower)) {
          follower.listener(event);
        }
      }
    },
  };
  return fake;
}
