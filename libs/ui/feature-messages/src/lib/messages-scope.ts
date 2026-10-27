import { inject, InjectionToken, type Provider } from '@angular/core';
import {
  TRANSLOCO_SCOPE,
  type ProviderScope,
  type Translation,
} from '@jsverse/transloco';

/** The Transloco scope name of this feature; its keys read `publish.<path>` (M1-46, R12). */
export const MESSAGES_SCOPE = 'publish';

/**
 * Where the scope's JSON comes from: an `import()` of the bundled file, never an HTTP request (`fetch` is
 * banned outside the platform library and the CSP allows scripts from 'self' only). A spec replaces it to
 * see which key a view asked for.
 */
export const MESSAGES_SCOPE_LOADER = new InjectionToken<
  () => Promise<Translation>
>('MESSAGES_SCOPE_LOADER', {
  providedIn: 'root',
  factory: () => () => import('../i18n/en.json').then((m) => m.default),
});

/**
 * Registers the `publish` scope for the views under a route. A scope provided on a route replaces its
 * parent's, so the studio lists only this one.
 */
export function provideMessagesScope(): Provider {
  return {
    provide: TRANSLOCO_SCOPE,
    multi: true,
    useFactory: (): ProviderScope => {
      const load = inject(MESSAGES_SCOPE_LOADER);
      return {
        scope: MESSAGES_SCOPE,
        loader: { en: () => load() },
      };
    },
  };
}
