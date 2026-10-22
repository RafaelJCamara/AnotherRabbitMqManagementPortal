import { inject, InjectionToken, type Provider } from '@angular/core';
import {
  TRANSLOCO_SCOPE,
  type ProviderScope,
  type Translation,
} from '@jsverse/transloco';

/** The Transloco scope name of this feature; its keys read `connections.<path>` (M0-52, R11). */
export const CONNECTIONS_SCOPE = 'connections';

/**
 * Where the scope's JSON comes from: an `import()` of the bundled file, never an HTTP request (`fetch` is
 * banned outside the platform library and the CSP allows scripts from 'self' only). A spec replaces it to
 * see which key a view asked for.
 */
export const CONNECTIONS_SCOPE_LOADER = new InjectionToken<
  () => Promise<Translation>
>('CONNECTIONS_SCOPE_LOADER', {
  providedIn: 'root',
  factory: () => () => import('../i18n/en.json').then((m) => m.default),
});

/**
 * Registers the `connections` scope for the views under a route. A scope provided on a route replaces its
 * parent's, so the connections views list only this one.
 */
export function provideConnectionsScope(): Provider {
  return {
    provide: TRANSLOCO_SCOPE,
    multi: true,
    useFactory: (): ProviderScope => {
      const load = inject(CONNECTIONS_SCOPE_LOADER);
      return {
        scope: CONNECTIONS_SCOPE,
        loader: { en: () => load() },
      };
    },
  };
}
