import type { Route, Routes } from '@angular/router';
import { EXPLORER_KINDS, type ExplorerKind } from '@app/explorer-model';

import { provideExplorerScope } from './explorer-scope';

/** One inventory page per kind; they share one lazy chunk, the grid page. */
function inventoryRoute(kind: ExplorerKind): Route {
  return {
    path: kind,
    data: { kind },
    loadComponent: () =>
      import('./grid/inventory-route.component').then((m) => m.InventoryRoute),
  };
}

/**
 * The child routes the web shell mounts at `c/:cid/explorer` (it provides `EXPLORER_CONNECTION` on
 * the mounting route): the overview at the empty path and one grid per kind. An address that is
 * none of these falls through to the shell's not-found view.
 */
export const explorerRoutes: Routes = [
  {
    path: '',
    providers: [provideExplorerScope()],
    children: [
      {
        path: '',
        pathMatch: 'full',
        loadComponent: () =>
          import('./explorer.component').then((m) => m.ExplorerComponent),
      },
      ...EXPLORER_KINDS.map(inventoryRoute),
    ],
  },
];
