import { InjectionToken, type Signal } from '@angular/core';

/**
 * The connection the explorer reads, as a signal of its id. The web shell provides it on the route
 * that mounts the explorer (from its active connection); a feature never imports `apps/web`.
 * `null` means no connection: the pages show no content and make no call (M0-54, R11).
 */
export const EXPLORER_CONNECTION = new InjectionToken<Signal<string | null>>(
  'EXPLORER_CONNECTION',
);
