// The routes of the entity pages (M1-42, R1): `/c/:cid/{queues|exchanges|connections|bindings}/:key[/:tab]`, one
// lazy mount per kind in the shell. One matcher takes the key and the optional tab, so the same page component is
// reused when only the tab (or the key) changes. An address with more segments falls through to the mounting
// app's not-found view.
import type { Signal } from '@angular/core';
import type { Routes, UrlMatchResult, UrlSegment } from '@angular/router';
import type { ExplorerKind } from '@app/explorer-model';

import { EXPLORER_CONNECTION } from '../connection';
import { provideExplorerScope } from '../explorer-scope';

function entityMatcher(segments: UrlSegment[]): UrlMatchResult | null {
  const [key, tab] = segments;
  if (key === undefined || segments.length > 2) return null;
  return {
    consumed: segments,
    posParams: tab === undefined ? { key } : { key, tab },
  };
}

/**
 * The routes of one kind of entity, with the connection given by the mounting app (as `explorerRoutesFor`):
 * `loadChildren: () => import('@app/feature-explorer').then((m) => m.entityRoutesFor('queues', () =>
 * inject(ActiveConnection).cid))`. A `null` id shows no content and makes no call.
 */
export function entityRoutesFor(
  kind: ExplorerKind,
  connection: () => Signal<string | null>,
): Routes {
  return [
    {
      path: '',
      providers: [
        { provide: EXPLORER_CONNECTION, useFactory: connection },
        provideExplorerScope(),
      ],
      children: [
        {
          matcher: entityMatcher,
          data: { kind },
          loadComponent: () =>
            import('./entity-route.component').then((m) => m.EntityRoute),
        },
      ],
    },
  ];
}
