// Public API of this library. Export only what other projects need.
export {
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
  type ChartDef,
  type ChartId,
  type ChartUnit,
  type LineData,
  type LineDef,
  type RangeDef,
} from './chart-defs';
export {
  explainStatus,
  KNOWN_PARTIAL_REASONS,
  type Explanation,
  type ExplanationCode,
} from './explain';
export { forecastView, type ForecastView } from './forecast-view';
export type {
  LiveFeedEvent,
  LiveItem,
  LiveParams,
  MetricsData,
  MetricsForecastInput,
  MetricsForecastOutput,
  MetricsQueryInput,
  MetricsQueryOutput,
  MetricsStatus,
  QueueRef,
  SeriesRef,
  SeriesResult,
} from './ports';
export { refKey } from './series-key';
export {
  BYTES_PER_POINT,
  RING_MAX_BYTES,
  RING_MAX_POINTS,
  SeriesRing,
  type RingOptions,
  type RingPoint,
  type RingStats,
} from './series-ring';
export {
  createMetricsSession,
  HISTORY_MAX_POINTS,
  SUMMARY_EVERY_MS,
  type LiveState,
  type MetricsSession,
  type SeriesState,
  type SeriesView,
  type SessionConfig,
  type SessionPhase,
  type SessionState,
  type SummaryFacts,
} from './session';
