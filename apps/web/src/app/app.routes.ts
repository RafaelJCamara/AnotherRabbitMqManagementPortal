import type { Route } from '@angular/router';

import { noConnectionRoute, shellRoute } from './shell/shell.routes';

/**
 * Set by the build (`define` in project.json): true in the development configuration, false in
 * production. It is undefined when the code runs outside a build (a bare test runner), which
 * counts as false.
 */
declare const __DEV_GALLERY__: boolean | undefined;

/**
 * The dev-only component gallery. The condition is a build-time constant, so a production build
 * drops the whole expression, the dynamic import and its chunk with it; `pnpm nx run
 * web-gallery-check:gallery-absent` builds for production and proves that.
 */
const devRoutes: Route[] =
  typeof __DEV_GALLERY__ !== 'undefined' && __DEV_GALLERY__
    ? [
        {
          path: 'gallery',
          loadComponent: () =>
            import('./gallery/gallery').then((module) => module.Gallery),
        },
      ]
    : [];

/**
 * The connections pages (M0-52): the list, the create form, one connection and its edit form. They are outside
 * c/:cid, which needs a connection. The library is lazy and loads when the address is first visited.
 */
const connectionsRoute: Route = {
  path: 'connections',
  loadChildren: () =>
    import('@app/feature-connections').then(
      (module) => module.connectionsRoutes,
    ),
};

export const appRoutes: Route[] = [
  ...devRoutes,
  connectionsRoute,
  shellRoute,
  noConnectionRoute,
];
