import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import { PAGE_RELOAD } from '../../boot/page-reload';
import { ChunkReload } from './chunk-reload';

/**
 * Shown when a part of the app could not be loaded and the automatic reload already happened a
 * moment ago (AC-13): it says so and offers a reload by hand. It names no address and no error
 * text.
 */
@Component({
  selector: 'app-chunk-failure',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (chunk.failure() !== null) {
      <section class="failure" role="alert">
        <h1>{{ 'system.chunk.title' | transloco }}</h1>
        <p>{{ 'system.chunk.hint' | transloco }}</p>
        <button type="button" (click)="reload()">
          {{ 'system.chunk.reload' | transloco }}
        </button>
      </section>
    }
  `,
  styles: `
    .failure {
      padding: var(--ds-space-4);
      background: var(--ds-color-warning);
      color: var(--ds-color-on-warning);
    }
    h1 {
      margin: 0 0 var(--ds-space-2);
      font-size: 1.25em;
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
export class ChunkFailure {
  protected readonly chunk = inject(ChunkReload);
  readonly #reload = inject(PAGE_RELOAD);

  protected reload(): void {
    this.#reload();
  }
}
