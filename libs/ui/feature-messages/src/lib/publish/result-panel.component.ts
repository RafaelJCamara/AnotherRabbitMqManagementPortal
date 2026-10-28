// The result of a send (R5, I-13): every copy of the engine's answer once, each under its own words, the seven counts,
// and a success line only when the engine said every copy was confirmed. A returned, timed-out or nacked copy is never
// folded into success. Nothing the person typed is shown here: only what the engine reported. Text only.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';

import {
  copyText,
  OUTCOME_ORDER,
  outcomeName,
  type PublishResult,
} from './outcome-text';

@Component({
  selector: 'app-result-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective],
  template: `
    <ng-container *transloco="let t">
      <section
        class="result"
        aria-labelledby="publish-result-title"
        [attr.data-state]="result().allConfirmed ? 'all-confirmed' : 'not-all'"
      >
        <h2 id="publish-result-title">{{ t('publish.result.title') }}</h2>
        <p class="headline">
          @if (result().allConfirmed) {
            {{
              total() === 1
                ? t('publish.result.allConfirmedOne')
                : t('publish.result.allConfirmed', { count: total() })
            }}
          } @else {
            {{
              t('publish.result.notAll', {
                confirmed: result().summary.confirmed,
                count: total(),
              })
            }}
          }
        </p>
        @if (!result().historyRecorded) {
          <p class="notice" data-notice="history-not-recorded">
            {{ t('publish.result.historyNotRecorded') }}
          </p>
        }
        <ul class="summary" [attr.aria-label]="t('publish.result.summary')">
          @for (outcome of order; track outcome) {
            <li [attr.data-summary]="outcome">
              <span class="name">{{ name(t, outcome) }}</span
              >: <span class="count">{{ result().summary[outcome] }}</span>
            </li>
          }
        </ul>
        <ol class="copies" [attr.aria-label]="t('publish.result.copies')">
          @for (copy of rows(t); track $index) {
            <li
              [attr.data-outcome]="copy.outcome"
              [attr.data-index]="copy.index"
            >
              <p class="lead">
                <span class="n">{{
                  t('publish.result.copy', { n: copy.index + 1 })
                }}</span
                >&ngsp;<strong class="label">{{ copy.text.label }}</strong>
              </p>
              <p class="why">{{ copy.text.explanation }}</p>
              @if (copy.text.detail; as detail) {
                <p class="detail">{{ detail }}</p>
              }
            </li>
          }
        </ol>
        <p class="note">{{ t('publish.result.noUndo') }}</p>
      </section>
    </ng-container>
  `,
  styles: `
    .result {
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      padding: var(--ds-space-3);
    }
    .result[data-state='all-confirmed'] {
      border-inline-start: 6px solid var(--ds-color-success);
    }
    .result[data-state='not-all'] {
      border-inline-start: 6px solid var(--ds-color-warning);
    }
    h2 {
      margin: 0 0 var(--ds-space-2);
      font-size: 1.15em;
    }
    p {
      margin: 0 0 var(--ds-space-1);
    }
    .headline {
      font-weight: 600;
    }
    .notice {
      padding: var(--ds-space-2);
      background: var(--ds-color-surface-sunken);
      border-inline-start: 4px solid var(--ds-color-warning);
    }
    .summary {
      display: flex;
      flex-wrap: wrap;
      gap: var(--ds-space-1) var(--ds-space-3);
      list-style: none;
      padding: 0;
      margin: var(--ds-space-2) 0;
    }
    .copies {
      margin: 0;
      padding-inline-start: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: var(--ds-space-2);
    }
    .copies li {
      padding: var(--ds-space-1) var(--ds-space-2);
      border-inline-start: 4px solid var(--ds-color-border-strong);
    }
    .copies li[data-outcome='confirmed'] {
      border-inline-start-color: var(--ds-color-success);
    }
    .copies li[data-outcome='returned'],
    .copies li[data-outcome='timeout'],
    .copies li[data-outcome='nacked'],
    .copies li[data-outcome='failed'],
    .copies li[data-outcome='blocked'] {
      border-inline-start-color: var(--ds-color-warning);
    }
    .n {
      color: var(--ds-color-text-muted);
      margin-inline-end: var(--ds-space-2);
    }
    .why,
    .detail,
    .note {
      color: var(--ds-color-text-muted);
    }
  `,
})
export class ResultPanel {
  readonly result = input.required<PublishResult>();

  protected readonly order = OUTCOME_ORDER;
  protected readonly total = computed(() => this.result().copies.length);

  protected name = outcomeName;

  protected rows(t: Parameters<typeof copyText>[0]) {
    return this.result().copies.map((copy) => ({
      index: copy.index,
      outcome: copy.outcome,
      text: copyText(t, copy),
    }));
  }
}
