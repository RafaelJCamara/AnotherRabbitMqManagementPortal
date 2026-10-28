// An engine failure shown as it was sent (R8): the title, the detail, the gate's reason and source when the Problem
// carries a gate, and the stable code, all as text; then a fixed hint chosen by the code, which is ours and says what
// the person can do. A live region, so a screen reader hears a failure when it appears.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';

import { hintKey, type ProblemView } from './problem';

@Component({
  selector: 'app-problem-alert',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective],
  template: `
    <ng-container *transloco="let t">
      <div class="problem" role="alert">
        <p class="title">
          {{ problem().title || t('publish.problem.unknown') }}
        </p>
        @if (problem().detail; as detail) {
          <p class="detail">{{ detail }}</p>
        }
        @if (problem().gate; as gate) {
          @if (gate.reason) {
            <p class="gate">
              <span class="key">{{ t('publish.problem.why') }}</span>
              {{ gate.reason }}
              @if (gate.source) {
                <span class="source"
                  >{{ t('publish.problem.source') }} {{ gate.source }}</span
                >
              }
            </p>
          }
        }
        @if (problem().code; as code) {
          <p class="code">
            <span class="key">{{ t('publish.problem.code') }}</span
            >&ngsp;<code>{{ code }}</code>
          </p>
        }
        @if (hint(); as key) {
          <p class="hint" data-hint>{{ t(key) }}</p>
        }
      </div>
    </ng-container>
  `,
  styles: `
    .problem {
      padding: var(--ds-space-2) var(--ds-space-3);
      border-inline-start: 6px solid var(--ds-color-danger);
      background: var(--ds-color-surface-sunken);
    }
    p {
      margin: 0 0 var(--ds-space-1);
    }
    .title {
      font-weight: 600;
    }
    .key {
      color: var(--ds-color-text-muted);
      margin-inline-end: var(--ds-space-1);
    }
    .source {
      margin-inline-start: var(--ds-space-2);
      color: var(--ds-color-text-muted);
    }
    .hint {
      color: var(--ds-color-text-muted);
    }
  `,
})
export class ProblemAlert {
  readonly problem = input.required<ProblemView>();

  protected readonly hint = computed(() => hintKey(this.problem().code));
}
