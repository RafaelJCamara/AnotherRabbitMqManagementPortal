export { createMetricsModule } from './module';
export type { MetricsModule, MetricsTopicBinding } from './module';
export type { MetricsLimits, MetricsModuleDeps } from './deps';
export { DEFAULT_METRICS_LIMITS } from './deps';
// Fakes for the ports of this module, for the architecture manifest and the HTTP specs.
export { createMetricsFakeDeps } from './testing';
export { createMetricsQueryAction } from './actions/metrics-query';
export { createMetricsForecastAction } from './actions/metrics-forecast';
// The planner is pure and public: the lab run and the perf harness read the plan it makes.
export { planScrape } from './internal/scrape-planner';
export type {
  PlanInput,
  ScrapePlan,
  ScrapeTarget,
} from './internal/scrape-planner';
// The store and the round, for the perf harness (perf:metrics-100k), which feeds them 400,000 series.
export { createHotStore } from './internal/store-hot';
export type { HotStore } from './internal/store-hot';
export { beginRound } from './internal/ingest';
