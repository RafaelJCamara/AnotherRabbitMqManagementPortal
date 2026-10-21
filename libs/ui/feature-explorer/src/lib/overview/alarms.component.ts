// The alarms of the cluster (M0-54, R9, R13): an active alarm is an alert region that names each node and its
// resource; none says no alarm is reported; unknown says the state could not be read, with the engine's reason,
// and is never worded as none (I-13).
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';

import type { OverviewAlarms } from './overview-model';

@Component({
  selector: 'app-overview-alarms',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective],
  template: `
    <ng-container *transloco="let t">
      @switch (alarms().state) {
        @case ('active') {
          <div class="alarm" role="alert">
            <p>{{ t('explorer.overview.alarms.active') }}</p>
            <ul>
              @for (alarm of active(); track $index) {
                <li>
                  {{
                    t('explorer.overview.alarms.item', {
                      node: alarm.node,
                      resource: t(
                        'explorer.overview.alarms.resource.' + alarm.resource
                      ),
                    })
                  }}
                </li>
              }
            </ul>
          </div>
        }
        @case ('none') {
          <p class="none">{{ t('explorer.overview.alarms.none') }}</p>
        }
        @default {
          <p class="unknown">
            {{ t('explorer.overview.alarms.unknown') }}
            <span class="reason">{{ reason() }}</span>
          </p>
        }
      }
    </ng-container>
  `,
  styles: `
    .alarm {
      border-inline-start: 4px solid var(--ds-color-text-danger);
      padding-inline-start: var(--ds-space-3);
      color: var(--ds-color-text-danger);
      font-weight: 600;
    }
    .none,
    .unknown {
      margin: 0;
    }
    .reason {
      margin-inline-start: var(--ds-space-2);
      color: var(--ds-color-text-muted);
    }
  `,
})
export class OverviewAlarmsView {
  readonly alarms = input.required<OverviewAlarms>();

  protected active() {
    const alarms = this.alarms();
    return alarms.state === 'active' ? alarms.active : [];
  }

  /** The engine's fixed text, as sent. */
  protected reason(): string {
    const alarms = this.alarms();
    return alarms.state === 'unknown' ? alarms.reason : '';
  }
}
