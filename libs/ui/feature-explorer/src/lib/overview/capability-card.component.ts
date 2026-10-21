// The capability card (M0-54, R10): what the engine says the connected broker lets the product do, one row per
// gate, as sent. It makes no call of its own beyond reading the profile and has no control that needs a gate:
// the rows are display rows built with the fail-closed rules of `<app-gated>` (a gate is open only for
// `enabled: true`; a source is a link only when it is an absolute https URL without credentials). It never
// computes authorisation, and a profile that is absent, failed or unreadable says the capabilities are unknown.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';

import { ProfileStore } from '../profile/profile-store';
import { capabilityRows } from './capability-model';

@Component({
  selector: 'app-capability-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective],
  template: `
    <ng-container *transloco="let t">
      @if (loading()) {
        <p class="unknown" role="status">
          {{ t('explorer.capabilities.loading') }}
        </p>
      } @else if (rows(); as rows) {
        <table class="gates">
          <caption>
            {{
              t('explorer.capabilities.caption')
            }}
          </caption>
          <thead>
            <tr>
              <th scope="col">
                {{ t('explorer.capabilities.featureColumn') }}
              </th>
              <th scope="col">{{ t('explorer.capabilities.state') }}</th>
              <th scope="col">{{ t('explorer.capabilities.why') }}</th>
            </tr>
          </thead>
          <tbody>
            @for (row of rows; track row.id) {
              <tr>
                <th scope="row">
                  {{
                    row.known
                      ? t('explorer.capabilities.feature.' + row.id)
                      : row.id
                  }}
                </th>
                <td>{{ t('explorer.capabilities.states.' + row.state) }}</td>
                <td>
                  @if (row.state !== 'open') {
                    <span class="reason">{{
                      row.reason ?? t('explorer.capabilities.noReason')
                    }}</span
                    >&ngsp;
                    @if (row.link; as link) {
                      <a
                        class="source"
                        [href]="link.href"
                        target="_blank"
                        rel="noopener noreferrer"
                        >{{ t('explorer.capabilities.source') }}
                        {{ link.host }}</a
                      >
                    } @else if (row.source) {
                      <span class="source"
                        >{{ t('explorer.capabilities.source') }}
                        {{ row.source }}</span
                      >
                    }
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      } @else {
        <p class="unknown">{{ t('explorer.capabilities.unknown') }}</p>
      }
    </ng-container>
  `,
  styles: `
    .gates {
      border-collapse: collapse;
      min-width: 30rem;
    }
    th,
    td {
      padding: var(--ds-space-1) var(--ds-space-3);
      border-bottom: 1px solid var(--ds-color-border);
      text-align: start;
      font-size: var(--ds-font-size);
      vertical-align: top;
    }
    caption {
      text-align: start;
      color: var(--ds-color-text-muted);
      padding-bottom: var(--ds-space-1);
    }
    .source {
      margin-inline-start: var(--ds-space-2);
      color: var(--ds-color-text-link);
    }
    .source:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: 2px;
    }
    .unknown {
      margin: 0;
    }
  `,
})
export class CapabilityCard {
  readonly #profile = inject(ProfileStore);

  protected readonly loading = computed(
    () => this.#profile.state().status === 'loading',
  );

  /** `null` (unknown) when the call failed or the profile has no readable gates: never "available". */
  protected readonly rows = computed(() => {
    const state = this.#profile.state();
    return state.status === 'loading' || state.error !== null
      ? null
      : capabilityRows(state.raw);
  });
}
