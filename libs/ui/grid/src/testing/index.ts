// Test support for grid specs and the perf harness: a deterministic fake engine window.
// Imported as `@app/ui-grid/testing`; it is not part of the production API of ui-grid.
export {
  createFakeWindowSource,
  fakeRow,
  type FakeRow,
  type FakeWindowSource,
  type FakeWindowSourceOptions,
} from './fake-window-source';

// Renders every row and column in a test DOM, which has no layout (never provide this in an app).
export { provideGridRenderAll } from './render-all';
