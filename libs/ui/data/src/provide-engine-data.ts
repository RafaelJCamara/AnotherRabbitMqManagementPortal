// The HttpClient setup of the UI: the interceptor chain of blueprint 10 on top of the engine
// transport. The backend override comes after `provideHttpClient` inside one provider list, so
// the order cannot be got wrong in an app config.
import {
  HttpBackend,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import {
  makeEnvironmentProviders,
  type EnvironmentProviders,
} from '@angular/core';
import { EngineTransportHttpBackend } from '@app/ui-platform';

import { ENGINE_INTERCEPTORS } from './interceptors';
import {
  LIVE_CLIENT_CONFIG,
  DEFAULT_LIVE_CLIENT_CONFIG,
  type LiveClientConfig,
} from './live-client';

/**
 * `HttpClient` with the correlation, auth and problem interceptors, sending through whatever
 * `ENGINE_TRANSPORT` provides (see `providePlatform` in @app/ui-platform).
 */
export function provideEngineData(
  options: { readonly live?: Partial<LiveClientConfig> } = {},
): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideHttpClient(withInterceptors([...ENGINE_INTERCEPTORS])),
    { provide: HttpBackend, useExisting: EngineTransportHttpBackend },
    ...(options.live === undefined
      ? []
      : [
          {
            provide: LIVE_CLIENT_CONFIG,
            useValue: { ...DEFAULT_LIVE_CLIENT_CONFIG, ...options.live },
          },
        ]),
  ]);
}
