import { InjectionToken } from '@angular/core';

/** Runs a callback after a delay; returns a function that cancels it. Specs provide a manual clock. */
export interface ExplorerTimer {
  set(callback: () => void, ms: number): () => void;
}

export const EXPLORER_TIMER = new InjectionToken<ExplorerTimer>(
  'EXPLORER_TIMER',
  {
    providedIn: 'root',
    factory: () => ({
      set: (callback, ms) => {
        const handle = setTimeout(callback, ms);
        return () => {
          clearTimeout(handle);
        };
      },
    }),
  },
);
