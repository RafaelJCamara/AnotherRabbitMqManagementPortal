import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import { PAGE_RELOAD } from '../../boot/page-reload';
import { VersionSkew } from './version-skew';

/**
 * Offers a reload when the engine is newer than this page. It is a status message, not a dialog:
 * it takes no focus, blocks nothing and changes no state, so showing it never costs the person any
 * work; the reload keeps the address (AC-14).
 */
@Component({
  selector: 'app-skew-banner',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (skew.mismatch()) {
      <div class="banner" role="status">
        <span>{{ 'system.skew.message' | transloco }}</span>
        <button type="button" (click)="reload()">
          {{ 'system.skew.reload' | transloco }}
        </button>
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .banner {
      display: flex;
      flex-wrap: wrap;
      gap: var(--ds-space-2) var(--ds-space-3);
      align-items: center;
      padding: var(--ds-space-1) var(--ds-space-3);
      background: var(--ds-color-info);
      color: var(--ds-color-on-info);
      border-block-end: 1px solid var(--ds-color-border);
    }
    button {
      min-height: var(--ds-target-size);
      font: inherit;
    }
    button:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
    }
  `,
})
export class SkewBanner {
  protected readonly skew = inject(VersionSkew);
  readonly #reload = inject(PAGE_RELOAD);

  protected reload(): void {
    this.#reload();
  }
}
