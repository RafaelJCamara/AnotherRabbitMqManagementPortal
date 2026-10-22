import { InjectionToken } from '@angular/core';

/**
 * Runs a callback once at the next animation frame; returns a function that cancels it. The charts redraw at most
 * once per frame however many points arrive (M1-54, "setData in rAF; coalesced updates"). A spec provides a
 * manual scheduler.
 */
export interface MetricsFrame {
  request(callback: () => void): () => void;
}

export const METRICS_FRAME = new InjectionToken<MetricsFrame>('METRICS_FRAME', {
  providedIn: 'root',
  factory: () => ({
    request: (callback) => {
      if (typeof requestAnimationFrame === 'function') {
        const handle = requestAnimationFrame(callback);
        return () => {
          cancelAnimationFrame(handle);
        };
      }
      const handle = setTimeout(callback, 16);
      return () => {
        clearTimeout(handle);
      };
    },
  }),
});
