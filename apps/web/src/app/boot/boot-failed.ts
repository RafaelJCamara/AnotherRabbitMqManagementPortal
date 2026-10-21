import {
  ChangeDetectionStrategy,
  Component,
  inject,
  InjectionToken,
} from '@angular/core';
import type { BootstrapErrorCode } from '@app/ui-platform';
import { TranslocoPipe } from '@jsverse/transloco';

import { bindDocumentTitle } from '../i18n/document-title';
import { PAGE_RELOAD } from './page-reload';

/** Why start-up failed: a `BootstrapError` code, or `unknown` for anything else. */
export type BootFailureCause = BootstrapErrorCode | 'unknown';

export const BOOT_FAILURE = new InjectionToken<BootFailureCause>(
  'BOOT_FAILURE',
);

/** The `system.boot.cause.*` key of each cause. The text names the class of failure only. */
export const CAUSE_KEYS: Readonly<Record<BootFailureCause, string>> = {
  'bridge-invalid': 'system.boot.cause.bridgeInvalid',
  'bridge-version': 'system.boot.cause.bridgeVersion',
  'port-timeout': 'system.boot.cause.portTimeout',
  'bootstrap-unavailable': 'system.boot.cause.bootstrapUnavailable',
  'bootstrap-invalid': 'system.boot.cause.bootstrapInvalid',
  unknown: 'system.boot.cause.unknown',
};

/**
 * The view the app starts instead of the shell when the platform cannot be set up. It has no
 * router, no HTTP and no engine access; it shows the class of the failure (never the error text,
 * which can carry a URL) and offers a reload. It mounts on the same host element as `App`.
 */
@Component({
  selector: 'app-root',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="boot-failed">
      <h1>{{ 'system.boot.title' | transloco }}</h1>
      <p>{{ causeKey | transloco }}</p>
      <p>{{ 'system.boot.hint' | transloco }}</p>
      <button type="button" (click)="reload()">
        {{ 'system.boot.reload' | transloco }}
      </button>
    </main>
  `,
  styles: `
    .boot-failed {
      max-width: 40rem;
      margin: var(--ds-space-4);
    }
  `,
})
export class BootFailed {
  readonly #reload = inject(PAGE_RELOAD);
  protected readonly causeKey = CAUSE_KEYS[inject(BOOT_FAILURE)];
  /** The page title, translated; the document title follows it. */
  readonly title = bindDocumentTitle();

  protected reload(): void {
    this.#reload();
  }
}
