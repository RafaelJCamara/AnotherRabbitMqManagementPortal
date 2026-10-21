// Starts the app (blueprint 10): set up the platform first, then the shell. When the platform
// cannot be set up, the app starts a minimal "cannot start" view instead and makes no engine call
// (AC-1, fail closed).
import {
  provideBrowserGlobalErrorListeners,
  type ApplicationConfig,
  type Type,
} from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideDesignSystem } from '@app/ui-design';
import {
  BootstrapError,
  bootstrapPlatform,
  browserEnvironment,
  type BootstrapEnvironment,
  type PlatformSetup,
} from '@app/ui-platform';

import { App } from '../app';
import { appConfig } from '../app.config';
import { provideI18n } from '../i18n/i18n.config';
import { BOOT_FAILURE, BootFailed, type BootFailureCause } from './boot-failed';

/** What `bootApp` calls out to. A spec replaces them; the app uses the defaults. */
export interface BootHooks {
  readonly bootstrapPlatform: (
    env: BootstrapEnvironment,
  ) => Promise<PlatformSetup>;
  readonly start: (
    root: Type<unknown>,
    config: ApplicationConfig,
  ) => Promise<unknown>;
}

const defaultHooks: BootHooks = {
  bootstrapPlatform,
  start: (root, config) => bootstrapApplication(root, config),
};

export function causeOf(error: unknown): BootFailureCause {
  return error instanceof BootstrapError ? error.code : 'unknown';
}

/** The providers of the "cannot start" view: translations and theme, nothing that talks out. */
export function bootFailedConfig(cause: BootFailureCause): ApplicationConfig {
  return {
    providers: [
      provideBrowserGlobalErrorListeners(),
      provideDesignSystem(),
      provideI18n(),
      { provide: BOOT_FAILURE, useValue: cause },
    ],
  };
}

export async function bootApp(
  env: BootstrapEnvironment = browserEnvironment(),
  hooks: Partial<BootHooks> = {},
): Promise<void> {
  const { bootstrapPlatform: setUp, start } = { ...defaultHooks, ...hooks };
  let setup: PlatformSetup;
  try {
    setup = await setUp(env);
  } catch (error) {
    const cause = causeOf(error);
    // The code names the class of failure; the message can carry a URL, so it is not logged.
    console.error('The app cannot start:', cause);
    await start(BootFailed, bootFailedConfig(cause));
    return;
  }
  await start(App, appConfig(setup));
}
