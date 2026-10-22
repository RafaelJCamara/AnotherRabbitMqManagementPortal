// Public API of this library: pure metric math (MON-05). No I/O, no clock, no randomness.
export { cleanSeries, type Point } from './series.ts';
export {
  counterRate,
  drainEtaFromRates,
  ewma,
  type CounterRateOptions,
  type RateEta,
} from './rate.ts';
export { linearFit, tQuantile95, type LinearFit } from './regression.ts';
export {
  DEFAULT_FORECAST_OPTIONS,
  drainEta,
  timeToLimit,
  type Direction,
  type DrainForecast,
  type ForecastOptions,
  type LimitForecast,
} from './forecast.ts';
