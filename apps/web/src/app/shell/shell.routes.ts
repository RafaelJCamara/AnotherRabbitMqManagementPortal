import { inject } from '@angular/core';
import type { Route } from '@angular/router';
import type { ExplorerKind } from '@app/explorer-model';
import { EXPLORER_KINDS } from '@app/explorer-model/entity';

import { provideScopes } from '../i18n/i18n.config';
import { ActiveConnection } from './active-connection';
import { provideShellNavigation } from './explorer-navigation';

/**
 * One lazy mount of the explorer library. The route wraps the feature's own routes with the shell's answer to
 * `EXPLORER_NAVIGATION` (an entity or a page opens as a workspace tab), and the feature gets the connection from the
 * shell's active one. The library is loaded when one of its addresses is first visited, never statically.
 */
function explorerMount(
  path: string,
  routes: (feature: typeof import('@app/feature-explorer')) => Route[],
): Route {
  return {
    path,
    loadChildren: () =>
      import('@app/feature-explorer').then((feature): Route[] => [
        {
          path: '',
          providers: [
            provideShellNavigation(
              feature.EXPLORER_NAVIGATION,
              feature.targetUrl,
            ),
          ],
          children: routes(feature),
        },
      ]),
  };
}

/**
 * The publish studio (M1-46): one lazy mount of the messages library at `publish`, given the shell's active
 * connection. The library is loaded when the address is first visited, never statically; with no connection (an id
 * that failed validation) the shell shows its no-connection view before this route is reached. There is no activity
 * entry or command yet (slice G).
 */
const publishMount: Route = {
  path: 'publish',
  loadChildren: () =>
    import('@app/feature-messages').then((feature) =>
      feature.messagesRoutesFor(() => inject(ActiveConnection).cid),
    ),
};

const entityMount = (kind: ExplorerKind): Route =>
  explorerMount(kind, (feature) =>
    feature.entityRoutesFor(kind, () => inject(ActiveConnection).cid),
  );

/**
 * Everything under `/c/:cid`. The host is lazy, and so are the views in it. The route lists every
 * translation scope its views use, because scopes provided here replace those of the app root.
 * The `explorer` child mounts the explorer feature's own lazy routes (M0-54): the feature gets the
 * connection from `EXPLORER_CONNECTION`, here the shell's active connection, so it never imports this
 * app and shows nothing (and calls nothing) when there is none. The entity pages (M1-42) are one mount per kind,
 * `queues/:key[/:tab]`, `exchanges/...`, `connections/...` and `bindings/...`. An address the feature does not
 * know falls through to the not-found view below.
 */
export const shellRoute: Route = {
  path: 'c/:cid',
  providers: [provideScopes('system', 'shell', 'status')],
  loadComponent: () => import('./shell').then((module) => module.Shell),
  children: [
    { path: '', pathMatch: 'full', redirectTo: 'explorer' },
    explorerMount('explorer', (feature) =>
      feature.explorerRoutesFor(() => inject(ActiveConnection).cid),
    ),
    ...EXPLORER_KINDS.map(entityMount),
    publishMount,
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
