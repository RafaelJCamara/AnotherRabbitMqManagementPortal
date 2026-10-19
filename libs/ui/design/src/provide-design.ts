import {
  type EnvironmentProviders,
  inject,
  makeEnvironmentProviders,
  provideAppInitializer,
} from '@angular/core';

import { ThemeService } from './theme.service';

/**
 * Creates the ThemeService before the first render, so the stored theme and density are on the
 * root element when the page first paints and not after it.
 */
export function provideDesignSystem(): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideAppInitializer(() => {
      inject(ThemeService);
    }),
  ]);
}
