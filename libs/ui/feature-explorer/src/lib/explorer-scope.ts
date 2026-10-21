import { inject, InjectionToken, type Provider } from '@angular/core';
import {
  TRANSLOCO_SCOPE,
  type ProviderScope,
  type Translation,
} from '@jsverse/transloco';

/** The Transloco scope name of this feature; its keys read `explorer.<path>` (M0-54, R12). */
export const EXPLORER_SCOPE = 'explorer';

/**
 * Where the scope's JSON comes from: an `import()` of the bundled file, never an HTTP request (`fetch` is
 * banned outside the platform library and the CSP allows scripts from 'self' only). A spec replaces it to
 * see which key a view asked for.
 */
export const EXPLORER_SCOPE_LOADER = new InjectionToken<
  () => Promise<Translation>
>('EXPLORER_SCOPE_LOADER', {
  providedIn: 'root',
  factory: () => () => import('../i18n/en.json').then((m) => m.default),
});

/**
 * Registers the `explorer` scope for the views under a route. A scope provided on a route replaces its
 * parent's, so the explorer views list only this one.
 */
export function provideExplorerScope(): Provider {
  return {
    provide: TRANSLOCO_SCOPE,
    multi: true,
    useFactory: (): ProviderScope => {
      const load = inject(EXPLORER_SCOPE_LOADER);
      return {
        scope: EXPLORER_SCOPE,
        loader: { en: () => load() },
      };
    },
  };
}
