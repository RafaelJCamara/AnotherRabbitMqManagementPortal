// Providers every connections component spec needs: Transloco in English with the feature's real scope. Never
// part of the library build.
import type { EnvironmentProviders, Provider } from '@angular/core';
import { provideTransloco } from '@jsverse/transloco';

import { provideConnectionsScope } from '../connections-scope';

export function scopeProviders(): (EnvironmentProviders | Provider)[] {
  return [
    provideTransloco({
      config: { availableLangs: ['en'], defaultLang: 'en', prodMode: true },
    }),
    provideConnectionsScope(),
  ];
}
