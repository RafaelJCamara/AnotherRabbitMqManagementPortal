import { DOCUMENT } from '@angular/common';
import { CSP_NONCE, inject, InjectionToken } from '@angular/core';

/**
 * The nonce AG Grid puts on the `<style>` elements it injects (`styleNonce`), so the grid runs under
 * `style-src 'self' 'nonce-N'` (ADR-021, S-04). The app can provide this token; if it does not,
 * Angular's `CSP_NONCE` is used, then the `csp-nonce` meta tag the shell writes (OQ-552).
 */
export const GRID_STYLE_NONCE = new InjectionToken<string | undefined>(
  'GRID_STYLE_NONCE',
  {
    providedIn: 'root',
    factory: (): string | undefined => {
      const fromAngular = inject(CSP_NONCE, { optional: true });
      if (fromAngular !== null && fromAngular !== '') return fromAngular;
      const meta = inject(DOCUMENT).querySelector<HTMLMetaElement>(
        'meta[name="csp-nonce"]',
      );
      return meta !== null && meta.content !== '' ? meta.content : undefined;
    },
  },
);

/**
 * Renders every row and column instead of only the visible ones. A test DOM has no layout, so AG Grid
 * would otherwise render nothing. Provided by `@app/ui-grid/testing`, never by the app.
 */
export const GRID_RENDER_ALL = new InjectionToken<boolean>('GRID_RENDER_ALL', {
  providedIn: 'root',
  factory: () => false,
});
