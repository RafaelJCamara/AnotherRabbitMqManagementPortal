import type { Provider } from '@angular/core';
import { TRANSLOCO_SCOPE, type ProviderScope } from '@jsverse/transloco';

/** The Transloco scope name of this feature; its keys read `explorer.<path>` (M0-54, R12). */
export const EXPLORER_SCOPE = 'explorer';

/**
 * Registers the `explorer` scope with a bundled-JSON loader (an `import()`, never an HTTP request:
 * `fetch` is banned outside the platform library and the CSP allows scripts from 'self' only).
 * A scope provided on a route replaces its parent's, so the explorer views list only this one.
 */
export function provideExplorerScope(): Provider {
  const scope: ProviderScope = {
    scope: EXPLORER_SCOPE,
    loader: { en: () => import('../i18n/en.json').then((m) => m.default) },
  };
  return { provide: TRANSLOCO_SCOPE, multi: true, useValue: scope };
}
