import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('metrics-model public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'BYTES_PER_POINT',
      'DEFAULT_RANGE',
      'HISTORY_MAX_POINTS',
      'KNOWN_PARTIAL_REASONS',
      'LATER_RANGES',
      'MAX_CHART_NODES',
      'RANGES',
      'RING_MAX_BYTES',
      'RING_MAX_POINTS',
      'SUMMARY_EVERY_MS',
      'SeriesRing',
      'chartData',
      'clusterCharts',
      'createMetricsSession',
      'domainOf',
      'explainStatus',
      'forecastView',
      'queueCharts',
      'rangeOf',
      'refKey',
      'seriesOf',
    ]);
  });
});
