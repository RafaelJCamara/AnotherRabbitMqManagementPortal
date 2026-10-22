import type { Routes } from '@angular/router';

import { provideConnectionsScope } from './connections-scope';

/**
 * The child routes of the connections pages, mounted by the web shell at `/connections` (outside `c/:cid`, which
 * needs a connection): the list, the create form, one connection and its edit form. An address that is none of
 * these falls through to the mounting app's not-found view. The parent provides the `connections` Transloco scope.
 */
export const connectionsRoutes: Routes = [
  {
    path: '',
    providers: [provideConnectionsScope()],
    loadComponent: () =>
      import('./connections-layout.component').then((m) => m.ConnectionsLayout),
    children: [
      {
        path: '',
        pathMatch: 'full',
        loadComponent: () =>
          import('./list/connection-list.component').then(
            (m) => m.ConnectionList,
          ),
      },
      {
        path: 'new',
        data: { mode: 'create' },
        loadComponent: () =>
          import('./form/connection-form.component').then(
            (m) => m.ConnectionForm,
          ),
      },
      {
        path: ':id/edit',
        data: { mode: 'edit' },
        loadComponent: () =>
          import('./form/connection-form.component').then(
            (m) => m.ConnectionForm,
          ),
      },
      {
        path: ':id',
        pathMatch: 'full',
        loadComponent: () =>
          import('./detail/connection-page.component').then(
            (m) => m.ConnectionPage,
          ),
      },
    ],
  },
];
