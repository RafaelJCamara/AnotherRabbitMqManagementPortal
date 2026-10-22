// The ports of the live charts' plain logic (M1-54): how it reads history and the forecast and follows the live
// topic. This library imports no Angular and no rxjs; `feature-explorer` maps `EngineApi` and the live client to
// these shapes. Every call here reads; nothing changes the broker.
import type {
  InputOf,
  ItemOf,
  metricsForecast,
  metricsLiveTopic,
  metricsQuery,
  OutputOf,
  ParamsOf,
} from '@app/contracts';

export type MetricsQueryInput = InputOf<typeof metricsQuery>;
export type MetricsQueryOutput = OutputOf<typeof metricsQuery>;
export type MetricsForecastInput = InputOf<typeof metricsForecast>;
export type MetricsForecastOutput = OutputOf<typeof metricsForecast>;
export type MetricsStatus = MetricsQueryOutput['status'];
export type SeriesRef = MetricsQueryInput['series'][number];
export type SeriesResult = MetricsQueryOutput['series'][number];
export type QueueRef = NonNullable<SeriesRef['queue']>;
export type LiveParams = ParamsOf<typeof metricsLiveTopic>;
export type LiveItem = ItemOf<typeof metricsLiveTopic>;

/**
 * What `metrics.live` sends a follower. The engine-backed port maps the live client's events to these; the model
 * never sees rxjs. `error` and `end` end the topic.
 */
export type LiveFeedEvent =
  | { readonly kind: 'snapshot'; readonly items: readonly LiveItem[] }
  | {
      readonly kind: 'delta';
      readonly upserts: readonly LiveItem[];
      readonly removes: readonly string[];
    }
  | { readonly kind: 'gap' }
  | { readonly kind: 'status'; readonly state: string }
  | { readonly kind: 'reset' }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'end' };

/** How the charts read and follow the metrics of one connection. */
export interface MetricsData {
  query(
    input: MetricsQueryInput,
    signal: AbortSignal,
  ): Promise<MetricsQueryOutput>;
  forecast(
    input: MetricsForecastInput,
    signal: AbortSignal,
  ): Promise<MetricsForecastOutput>;
  /** Starts a subscription to `metrics.live`; the returned function ends it. */
  follow(
    params: LiveParams,
    listener: (event: LiveFeedEvent) => void,
  ): () => void;
}
