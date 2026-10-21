// Transloco setup for the web app. Translations are JSON files bundled as lazy chunks and loaded
// with `import()`: the default HTTP loader would pass through the engine transport, `fetch` is
// banned outside libs/ui/platform (`@app/no-direct-fetch`), and the CSP allows scripts from 'self'
// only (OQ-526). English only for now (OQ-537).
import {
  InjectionToken,
  inject,
  isDevMode,
  makeEnvironmentProviders,
  type EnvironmentProviders,
  type Provider,
} from '@angular/core';
import {
  TRANSLOCO_SCOPE,
  provideTransloco,
  type ProviderScope,
  type Translation,
} from '@jsverse/transloco';

import type { ScopeName } from './scopes';

export const DEFAULT_LANG = 'en';

export type ScopeLoader = () => Promise<Translation>;
export type ScopeLoaders = Readonly<Record<ScopeName, ScopeLoader>>;

/** Where each scope's JSON comes from. A spec replaces it to see which keys a view asks for. */
export const SCOPE_LOADERS = new InjectionToken<ScopeLoaders>('SCOPE_LOADERS', {
  factory: () => ({
    shell: () => import('./en/shell.json').then((module) => module.default),
    status: () => import('./en/status.json').then((module) => module.default),
    system: () => import('./en/system.json').then((module) => module.default),
  }),
});

/** The Transloco scope object of one scope, with its inline (bundled) loader. */
export function scopeDefinition(
  loaders: ScopeLoaders,
  name: ScopeName,
): ProviderScope {
  return {
    scope: name,
    loader: { [DEFAULT_LANG]: () => loaders[name]() },
  };
}

/**
 * Makes the named scopes available to the pipes under an injector. Scopes provided in a child
 * injector replace those of its parent, so a route lists every scope its views use.
 */
export function provideScopes(...names: readonly ScopeName[]): Provider[] {
  return names.map(
    (name): Provider => ({
      provide: TRANSLOCO_SCOPE,
      multi: true,
      useFactory: (): ProviderScope =>
        scopeDefinition(inject(SCOPE_LOADERS), name),
    }),
  );
}

/** Transloco, English, and the `system` scope for the app root. */
export function provideI18n(): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideTransloco({
      config: {
        availableLangs: [DEFAULT_LANG],
        defaultLang: DEFAULT_LANG,
        reRenderOnLangChange: false,
        prodMode: !isDevMode(),
      },
    }),
    ...provideScopes('system'),
  ]);
}
