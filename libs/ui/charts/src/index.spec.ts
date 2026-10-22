import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('ui-charts public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'ChartTable',
      'DASHES',
      'LineChart',
      'MARKERS',
      'OVERLAY_ROOM',
      'Sparkline',
      'TABLE_ROWS_MAX',
      'TIME_STEPS_MS',
      'areaOf',
      'atOrBefore',
      'downsample',
      'forecastOverlay',
      'formatClock',
      'formatValue',
      'gapThreshold',
      'linearScale',
      'markerPath',
      'nearestIndex',
      'niceStep',
      'niceTicks',
      'pathOf',
      'segments',
      'stepCursor',
      'styleOf',
      'symlog',
      'timeStep',
      'timeTicks',
      'withOverlayRoom',
      'yAxis',
    ]);
  });
});
