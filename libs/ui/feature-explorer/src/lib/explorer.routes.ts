import type { Provider, Signal } from '@angular/core';
import type { Route, Routes } from '@angular/router';
import { EXPLORER_KINDS, type ExplorerKind } from '@app/explorer-model';

import { EXPLORER_CONNECTION } from './connection';
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

function routesWith(providers: Provider[]): Routes {
  return [
    {
      path: '',
      providers: [...providers, provideExplorerScope()],
      children: [
        {
          path: '',
          pathMatch: 'full',
          loadComponent: () =>
            import('./overview/overview.component').then((m) => m.OverviewPage),
        },
        ...EXPLORER_KINDS.map(inventoryRoute),
      ],
    },
  ];
}

/**
 * The child routes of the explorer: the overview at the empty path and one grid per kind. An address that
 * is none of these falls through to the mounting app's not-found view. The connection comes from
 * `EXPLORER_CONNECTION`, which the mounting route provides; use `explorerRoutesFor` to hand it in here.
 */
export const explorerRoutes: Routes = routesWith([]);

/**
 * The same routes with the connection given by the mounting app, so the app never imports this library
 * statically (it is a lazy library): `loadChildren: () => import('@app/feature-explorer').then((m) =>
 * m.explorerRoutesFor(() => inject(ActiveConnection).cid))`. The factory runs in an injection context. A
 * `null` id shows no content and makes no call (M0-54, R11).
 */
export function explorerRoutesFor(
  connection: () => Signal<string | null>,
): Routes {
  return routesWith([{ provide: EXPLORER_CONNECTION, useFactory: connection }]);
}
