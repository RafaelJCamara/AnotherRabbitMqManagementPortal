// Public API of this library. Export only what other projects need. The pure draw maths are `@app/chart-math`.
export { ChartTable, TABLE_ROWS_MAX } from './lib/chart-table.component';
export {
  DASHES,
  MARKERS,
  markerPath,
  styleOf,
  type ChartLabels,
  type ChartSeries,
  type MarkerShape,
  type SeriesStyle,
} from './lib/chart-types';
export { LineChart } from './lib/line-chart.component';
export { Sparkline } from './lib/sparkline.component';
