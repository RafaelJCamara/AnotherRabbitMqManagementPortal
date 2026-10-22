import { InjectionToken } from '@angular/core';

/** Runs a callback after a delay and returns the function that cancels it. A spec provides a manual clock. */
export interface CommandTimer {
  set(callback: () => void, ms: number): () => void;
}

export const COMMAND_TIMER = new InjectionToken<CommandTimer>('COMMAND_TIMER', {
  providedIn: 'root',
  factory: () => ({
    set: (callback, ms) => {
      const handle = setTimeout(callback, ms);
      return () => {
        clearTimeout(handle);
      };
    },
  }),
});
