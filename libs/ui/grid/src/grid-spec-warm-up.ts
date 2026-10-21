// For the component specs only (never part of the library build). The first AG Grid a test process
// creates pays one-time costs (module evaluation, the theme CSS, the first layout of jsdom). On a
// slow CI runner that was over 3 s on top of the ~1.7 s a grid test costs there, and it landed on
// whichever test ran first, which then hit the 5 s test timeout. Paying it in `beforeAll` keeps
// every test about the same size. Kept apart from `grid-spec-support.ts`, which the JIT-compiled
// specs import too and which must not load the component.
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { expect, vi } from 'vitest';

import { DataGrid } from './data-grid.component';
import { COLUMNS, LABELS, source } from './grid-spec-support';
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

/** Creates one grid, waits for its rows and tears it down, so the first test does not pay for it. */
export async function warmUpGrid(): Promise<void> {
  TestBed.configureTestingModule({ providers: [provideGridRenderAll()] });
  const fixture = TestBed.createComponent(WarmUpHost);
  const el = fixture.nativeElement as HTMLElement;
  document.body.append(el);
  try {
    await fixture.whenStable();
    await vi.waitFor(
      () => {
        expect(el.querySelectorAll('.ag-row').length).toBeGreaterThan(0);
      },
      { timeout: WARM_UP_TIMEOUT_MS - 5000 },
    );
  } finally {
    fixture.destroy();
    el.remove();
    TestBed.resetTestingModule();
  }
}
