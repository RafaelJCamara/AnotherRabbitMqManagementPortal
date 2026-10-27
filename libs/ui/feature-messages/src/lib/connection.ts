import { InjectionToken, type Signal } from '@angular/core';
import type { ConnectionId } from '@app/contracts';

/**
 * The connection the studio publishes on, as a signal of its id. The web shell provides it on the route that
 * mounts the studio (from its active connection); a feature never imports `apps/web`. `null` means no
 * connection: the page shows nothing and makes no call (M1-46, AC-19).
 */
export const PUBLISH_CONNECTION = new InjectionToken<
  Signal<ConnectionId | null>
>('PUBLISH_CONNECTION');
