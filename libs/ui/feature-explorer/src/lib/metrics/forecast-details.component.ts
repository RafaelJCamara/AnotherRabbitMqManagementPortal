// What the engine's forecast says, in words (M1-54, R5, MON-05): every state is explicit (an expected time with its
// 95 % band, empty already, moving away, no reliable forecast, not enough data) and an ETA appears only when the
// engine sent one. The numbers it was made from are listed in the full form; a failed read keeps the last answer,
// marked as earlier, with the engine's Problem as received.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';

import { hintKey, problemView } from '../problem';
import type { ForecastRead } from './forecast-store';
import { formatDuration } from './metrics-format';
import { forecastSentence } from './metrics-text';

let nextForecast = 0;

@Component({
  selector: 'app-forecast-details',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective],
  template: `
    <ng-container *transloco="let t">
      @if (read(); as r) {
        <section class="forecast" [attr.aria-labelledby]="id">
          <h3 [id]="id">{{ t('explorer.metrics.forecast.title') }}</h3>
          <div class="state" role="status">
            @if (r.view; as view) {
              <p class="sentence" [attr.data-state]="view.state">
                {{ sentence(view, t) }}
              </p>
              @if (r.earlier) {
                <p class="earlier">
                  {{ t('explorer.metrics.forecast.earlier') }}
                </p>
              }
            } @else if (r.phase === 'loading') {
              <p>{{ t('explorer.metrics.forecast.loading') }}</p>
            }
          </div>
          @if (r.phase === 'error') {
            <div class="failure" role="alert">
              <p>{{ t('explorer.metrics.forecast.failed') }}</p>
              @if (failure(); as problem) {
                <p>
                  <span class="problem">{{ problem.title }}</span>
                  @if (problem.detail) {
                    <span class="problem">{{ problem.detail }}</span>
                  }
                </p>
                @if (hint(problem.code); as key) {
                  <p class="hint">{{ t(key) }}</p>
                }
              }
            </div>
          }
          @if (!compact() && facts(); as list) {
            <dl class="facts">
              @for (fact of list; track fact.id) {
                <dt>{{ t('explorer.metrics.forecast.detail.' + fact.id) }}</dt>
                <dd>{{ fact.text }}</dd>
              }
            </dl>
          }
          <button type="button" class="refresh" (click)="refresh.emit()">
            {{ t('explorer.metrics.forecast.refresh') }}
          </button>
        </section>
      }
    </ng-container>
  `,
  styles: `
    :host {
      display: block;
    }
    .forecast {
      display: flex;
      flex-direction: column;
      gap: var(--ds-space-2);
    }
    h3,
    p {
      margin: 0;
    }
    .earlier,
    .hint {
      color: var(--ds-color-text-muted);
    }
    .failure {
      padding-inline-start: var(--ds-space-3);
      border-inline-start: 4px solid var(--ds-color-warning);
    }
    .facts {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: var(--ds-space-1) var(--ds-space-4);
      margin: 0;
    }
    dt {
      color: var(--ds-color-text-muted);
    }
    dd {
      margin: 0;
    }
    .refresh {
      align-self: start;
      min-height: var(--ds-target-size);
      padding: 0 var(--ds-space-3);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      background: var(--ds-color-surface);
      color: var(--ds-color-text);
      font: inherit;
      cursor: pointer;
    }
    .refresh:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: 2px;
    }
  `,
})
export class ForecastDetails {
  /** The forecast as read; `null` while nothing is read. */
  readonly read = input.required<ForecastRead | null>();
  /** Only the sentence, not the numbers it was made from. */
  readonly compact = input(false);
  /** Refresh was pressed. */
  readonly refresh = output();

  protected readonly id = `forecast-${String(nextForecast++)}`;
  protected readonly sentence = forecastSentence;
  protected readonly hint = hintKey;

  protected readonly failure = computed(() => {
    const read = this.read();
    return read?.phase === 'error' ? problemView(read.problem) : null;
  });

  /** The numbers behind an expected time or a refusal to give one. */
  protected readonly facts = computed(() => {
    const view = this.read()?.view;
    if (view === undefined || view === null) return null;
    switch (view.state) {
      case 'ok':
        return [
          { id: 'rate', text: `${view.ratePerSec.toFixed(2)}/s` },
          { id: 'fit', text: `${String(view.r2Percent)} %` },
          { id: 'window', text: formatDuration(view.windowMs) },
          { id: 'points', text: String(view.points) },
        ];
      case 'no-reliable-forecast':
        return [
          { id: 'fit', text: `${String(view.r2Percent)} %` },
          { id: 'window', text: formatDuration(view.windowMs) },
          { id: 'points', text: String(view.points) },
        ];
      case 'moving-away':
        return [
          { id: 'rate', text: `${view.ratePerSec.toFixed(2)}/s` },
          { id: 'fit', text: `${String(view.r2Percent)} %` },
        ];
      default:
        return null;
    }
  });
}
