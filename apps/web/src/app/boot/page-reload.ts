import { InjectionToken } from '@angular/core';

/** Reloads the page. A token so specs and the skew handling can replace it. */
export const PAGE_RELOAD = new InjectionToken<() => void>('PAGE_RELOAD', {
  factory: () => () => {
    globalThis.location.reload();
  },
});
