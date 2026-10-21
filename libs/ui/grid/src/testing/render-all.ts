import type { Provider } from '@angular/core';

import { GRID_RENDER_ALL } from '../grid-internals';

/** For specs only: AG Grid renders every row and column, because jsdom has no layout. */
export function provideGridRenderAll(): Provider {
  return { provide: GRID_RENDER_ALL, useValue: true };
}
