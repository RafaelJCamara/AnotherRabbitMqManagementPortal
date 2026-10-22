// Public API of this library. Export only what other projects need.
export { downsample, type Point } from './lib/draw/downsample';
export { formatClock, formatValue, type Unit } from './lib/draw/format';
export {
  forecastOverlay,
  OVERLAY_ROOM,
  withOverlayRoom,
  type Overlay,
  type OverlayForecast,
} from './lib/draw/overlay';
export { areaOf, gapThreshold, pathOf, segments } from './lib/draw/path';
export { atOrBefore, nearestIndex, stepCursor } from './lib/draw/pick';
export {
  linearScale,
  symlog,
  yAxis,
  type YAxis,
  type YScaleKind,
} from './lib/draw/scales';
export { niceStep, niceTicks, type NiceTicks } from './lib/draw/ticks';
export { TIME_STEPS_MS, timeStep, timeTicks } from './lib/draw/time-ticks';
