// What a page says when the engine has no usable profile of the connection (a first run: nobody has probed it
// yet), and the one button that fixes it. The probe reads the broker's management API with the stored login and
// keeps what it learns in the engine; the page that asked for it goes on by itself when the profile arrives,
// because it reads the same `ProfileStore`. A probe that fails shows the engine's Problem as sent, a sentence of
// help for the failures a first session meets (wrong login, broker not running), and leaves the button to press
// again. Nothing here computes authorisation.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';

import { hintKey, problemView } from '../problem';
import { ProfileStore, type ProbeNeed } from './profile-store';

@Component({
  selector: 'app-probe-prompt',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective],
  template: `
    <ng-container *transloco="let t">
      <p class="why">
        {{
          t(
            need() === 'outdated'
              ? 'explorer.probe.outdated'
              : 'explorer.probe.never'
          )
        }}
      </p>
      <p class="what">{{ t('explorer.probe.what') }}</p>
      <button
        type="button"
        class="run"
        [attr.aria-disabled]="running() ? 'true' : null"
        (click)="profile.probe()"
      >
        {{ running() ? t('explorer.probe.running') : t('explorer.probe.run') }}
      </button>
      <div class="result" role="status" aria-live="polite">
        @if (running()) {
          <p>{{ t('explorer.probe.runningStatus') }}</p>
        }
      </div>
      @if (failure(); as failure) {
        <div class="failure" role="alert">
          <p>{{ t('explorer.probe.failed') }}</p>
          <p>
            <span class="problem">{{ failure.title }}</span
            >&ngsp;
            @if (failure.detail) {
              <span class="problem">{{ failure.detail }}</span>
            }
          </p>
          @if (hint(); as key) {
            <p class="hint">{{ t(key) }}</p>
          }
        </div>
      }
    </ng-container>
  `,
  styles: `
    :host {
      display: block;
    }
    p {
      margin: 0 0 var(--ds-space-2);
    }
    .what,
    .hint,
    .problem {
      color: var(--ds-color-text-muted);
    }
    .run {
      min-height: var(--ds-target-size);
      padding: 0 var(--ds-space-3);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      background: var(--ds-color-accent);
      color: var(--ds-color-on-accent);
      font: inherit;
      cursor: pointer;
    }
    .run[aria-disabled='true'] {
      border-style: dashed;
      cursor: not-allowed;
    }
    .run:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: 2px;
    }
    .failure {
      margin-top: var(--ds-space-2);
      border-inline-start: 3px solid var(--ds-color-text-danger);
      padding-inline-start: var(--ds-space-3);
    }
  `,
})
export class ProbePrompt {
  /** Why the probe is offered: no profile was ever stored, or the stored one cannot be read by this version. */
  readonly need = input<ProbeNeed>('never');

  protected readonly profile = inject(ProfileStore);
  protected readonly running = computed(
    () => this.profile.probeState().status === 'running',
  );
  protected readonly failure = computed(() => {
    const state = this.profile.probeState();
    return state.status === 'failed' ? problemView(state.error) : null;
  });
  protected readonly hint = computed(() =>
    hintKey(this.failure()?.code ?? null),
  );
}
