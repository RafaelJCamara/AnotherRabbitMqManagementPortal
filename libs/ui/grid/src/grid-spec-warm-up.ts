// For the component specs only (never part of the library build). Two costs that have nothing to do
// with what a grid test checks are paid here once instead of in every test. Kept apart from
// `grid-spec-support.ts`, which the JIT-compiled specs import too and which must not load the component.
//
// 1. The first AG Grid a test process creates pays one-time costs (module evaluation, the first
//    layout of jsdom). On a slow CI runner that was over 3 s on top of the ~1.7 s a grid test costs
//    there, and it landed on whichever test ran first, which then hit the 5 s test timeout. Paying it
//    in `beforeAll` keeps every test about the same size.
// 2. AG Grid measures its elements with `getComputedStyle` about 90 times while it builds a grid.
//    jsdom answers each call by matching every selector of every stylesheet against the element and
//    its ancestors; in a CPU profile of repeated mounts that was 75 % of the time of a test (1.5 s of
//    2.0 s over 12 mounts), the grid's own code under 5 %. jsdom has no layout, so every size it
//    returns is empty and AG Grid reads zeros either way (which is why the specs provide
//    `provideGridRenderAll()`). Elements inside a grid get a fixed, empty answer instead; the
//    cascade is still computed for everything else (the theme service reads the document element).
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { getGridApi } from 'ag-grid-community';
import { expect } from 'vitest';

import { DataGrid } from './data-grid.component';
import { COLUMNS, eventually, LABELS, source } from './grid-spec-support';
import { provideGridRenderAll } from './testing/render-all';

/** Hook timeout for `beforeAll(warmUpGrid, WARM_UP_TIMEOUT_MS)`: ~0.3 s locally, several seconds cold on CI. */
export const WARM_UP_TIMEOUT_MS = 30_000;

@Component({
  imports: [DataGrid],
  template: `
    <div style="height: 400px">
      <app-data-grid [columns]="columns" [source]="source" [labels]="labels" />
    </div>
  `,
})
class WarmUpHost {
  readonly columns = COLUMNS;
  readonly source = source();
  readonly labels = LABELS;
}

let restoreComputedStyle: (() => void) | undefined;

/** Answers `getComputedStyle` for the elements of a grid without running jsdom's selector matching. */
function skipGridComputedStyle(): void {
  if (restoreComputedStyle) return;
  const installed = Reflect.get<Window, 'getComputedStyle'>(
    window,
    'getComputedStyle',
  );
  const original = installed.bind(window);
  const inert = original(document.createElement('div'));
  window.getComputedStyle = (
    element: Element,
    pseudoElement?: string | null,
  ): CSSStyleDeclaration =>
    element.closest('.ag-root-wrapper') === null
      ? original(element, pseudoElement)
      : inert;
  restoreComputedStyle = () => {
    window.getComputedStyle = installed;
    restoreComputedStyle = undefined;
  };
}

/** For `afterAll`: puts jsdom's own `getComputedStyle` back. */
export function restoreGridSpecEnvironment(): void {
  restoreComputedStyle?.();
}

/**
 * Resolves when AG Grid has dispatched the next event of this type. AG Grid delivers its events to the
 * listeners in the order they were added, and the component's own handler is added when the grid is
 * created, so once this resolves the component has handled that event: a test that expects "nothing
 * happened" awaits it instead of sleeping for a while. Call it before the event is sent.
 */
export function nextGridEvent(
  el: HTMLElement,
  type: 'cellKeyDown' | 'cellContextMenu',
): Promise<void> {
  const api = getGridApi(el.querySelector('.ag-root-wrapper'));
  if (!api) throw new Error('No grid in this element');
  return new Promise((resolve) => {
    const listener = (): void => {
      api.removeEventListener(type, listener);
      resolve();
    };
    api.addEventListener(type, listener);
  });
}

/** Creates one grid, waits for its rows and tears it down, so the first test does not pay for it. */
export async function warmUpGrid(): Promise<void> {
  skipGridComputedStyle();
  TestBed.configureTestingModule({ providers: [provideGridRenderAll()] });
  const fixture = TestBed.createComponent(WarmUpHost);
  const el = fixture.nativeElement as HTMLElement;
  document.body.append(el);
  try {
    await fixture.whenStable();
    await eventually(() => {
      expect(el.querySelectorAll('.ag-row').length).toBeGreaterThan(0);
    }, WARM_UP_TIMEOUT_MS - 5000);
  } finally {
    fixture.destroy();
    el.remove();
    TestBed.resetTestingModule();
  }
}
