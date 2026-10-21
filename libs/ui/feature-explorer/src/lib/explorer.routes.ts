import type { Routes } from '@angular/router';

import { provideExplorerScope } from './explorer-scope';

/**
 * The child routes the web shell mounts at `c/:cid/explorer` (it provides `EXPLORER_CONNECTION` on
 * the mounting route). The overview is the empty path; the grids are added with their pages.
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
    ],
  },
];
