// Test support for the component specs of features that mount `<app-data-grid>` (M0-54). Imported as
// `@app/ui-grid/testing/components`; it is not part of the production API of ui-grid and is kept apart
// from `@app/ui-grid/testing`, which Node code (the perf harness) imports and which must not load
// Angular, AG Grid or vitest.
import { getGridApi } from 'ag-grid-community';

export {
  nextGridEvent,
  restoreGridSpecEnvironment,
  warmUpGrid,
  WARM_UP_TIMEOUT_MS,
} from '../grid-spec-warm-up';
export { eventually, settled } from '../grid-spec-support';

/** The AG Grid API of the grid in an element, so a feature's spec can scroll it (no feature imports AG Grid). */
export function gridApiOf(el: HTMLElement) {
  const api = getGridApi(el.querySelector('.ag-root-wrapper'));
  if (!api) throw new Error('No grid in this element');
  return api;
}
