import type { Route } from '@angular/router';

import { provideScopes } from '../i18n/i18n.config';

/**
 * Everything under `/c/:cid`. The host is lazy, and so are the views in it. The route lists every
 * translation scope its views use, because scopes provided here replace those of the app root.
 * The `explorer` child is a placeholder until the explorer feature mounts its own route.
 */
export const shellRoute: Route = {
  path: 'c/:cid',
  providers: [provideScopes('system', 'shell', 'status')],
  loadComponent: () => import('./shell').then((module) => module.Shell),
  children: [
    { path: '', pathMatch: 'full', redirectTo: 'explorer' },
    {
      path: 'explorer',
      loadComponent: () =>
        import('./views/explorer-home').then((module) => module.ExplorerHome),
    },
    {
      path: '**',
      loadComponent: () =>
        import('./views/not-found').then((module) => module.NotFound),
    },
  ],
};

/** Every address outside `/c/:cid` has no connection to show. */
export const noConnectionRoute: Route = {
  path: '**',
  loadComponent: () =>
    import('./views/no-connection').then((module) => module.NoConnection),
};
