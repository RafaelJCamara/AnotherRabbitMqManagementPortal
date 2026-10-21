import { inject } from '@angular/core';
import type { Route } from '@angular/router';

import { provideScopes } from '../i18n/i18n.config';
import { ActiveConnection } from './active-connection';

/**
 * Everything under `/c/:cid`. The host is lazy, and so are the views in it. The route lists every
 * translation scope its views use, because scopes provided here replace those of the app root.
 * The `explorer` child mounts the explorer feature's own lazy routes (M0-54): the feature gets the
 * connection from `EXPLORER_CONNECTION`, here the shell's active connection, so it never imports this
 * app and shows nothing (and calls nothing) when there is none. An address the feature does not know
 * falls through to the not-found view below.
 */
export const shellRoute: Route = {
  path: 'c/:cid',
  providers: [provideScopes('system', 'shell', 'status')],
  loadComponent: () => import('./shell').then((module) => module.Shell),
  children: [
    { path: '', pathMatch: 'full', redirectTo: 'explorer' },
    {
      path: 'explorer',
      loadChildren: () =>
        import('@app/feature-explorer').then((module) =>
          module.explorerRoutesFor(() => inject(ActiveConnection).cid),
        ),
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
