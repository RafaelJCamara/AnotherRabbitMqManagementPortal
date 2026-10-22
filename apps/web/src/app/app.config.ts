import {
  provideBrowserGlobalErrorListeners,
  type ApplicationConfig,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideEngineData } from '@app/ui-data';
import { provideDesignSystem } from '@app/ui-design';
import { providePlatform, type PlatformSetup } from '@app/ui-platform';

import { appRoutes } from './app.routes';
import { provideI18n } from './i18n/i18n.config';
import { provideExplorerKindsSource } from './shell/explorer-tree/explorer-kinds-source';
import { provideChunkReload } from './shell/skew/chunk-reload';
import { provideLockState } from './shell/status-bar/lock-state';

/** The app proper, built from what the platform boot produced (see boot/boot.ts). */
export function appConfig(setup: PlatformSetup): ApplicationConfig {
  return {
    providers: [
      provideBrowserGlobalErrorListeners(),
      providePlatform(setup),
      provideEngineData(),
      provideDesignSystem(),
      provideI18n(),
      provideRouter(appRoutes),
      provideExplorerKindsSource(),
      provideLockState(),
      provideChunkReload(),
    ],
  };
}
