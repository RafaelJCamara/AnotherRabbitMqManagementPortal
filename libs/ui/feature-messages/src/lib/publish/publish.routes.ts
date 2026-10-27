import type { Provider, Signal } from '@angular/core';
import type { Routes } from '@angular/router';
import type { ConnectionId } from '@app/contracts';

import { PUBLISH_CONNECTION } from '../connection';
import { provideMessagesScope } from '../messages-scope';

/** The studio is one page; an address under it is not the studio's, so it falls through to the shell's not-found. */
function routesWith(providers: Provider[]): Routes {
  return [
    {
      path: '',
      pathMatch: 'full',
      providers: [...providers, provideMessagesScope()],
      loadComponent: () =>
        import('./studio.component').then((m) => m.PublishStudio),
    },
  ];
}

/**
 * The route the web shell mounts at `c/:cid/publish`. The connection comes from `PUBLISH_CONNECTION`, which the
 * mounting route provides; use `messagesRoutesFor` to hand it in.
 */
export const messagesRoutes: Routes = routesWith([]);

/**
 * The same route with the connection given by the mounting app, so the app never imports this lazy library
 * statically: `loadChildren: () => import('@app/feature-messages').then((m) => m.messagesRoutesFor(() =>
 * inject(ActiveConnection).cid))`. The factory runs in an injection context. A `null` id shows nothing and makes
 * no call.
 */
export function messagesRoutesFor(
  connection: () => Signal<ConnectionId | null>,
): Routes {
  return routesWith([{ provide: PUBLISH_CONNECTION, useFactory: connection }]);
}
