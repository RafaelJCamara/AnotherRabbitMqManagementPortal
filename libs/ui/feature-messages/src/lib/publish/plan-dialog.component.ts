// The plan dialog (R4, AC-30): what the engine's plan asks before a publish runs, rendered as sent. The gates that
// block (reason, source, the fixing action), the warnings, the approvals still missing, the consents as checkboxes
// and the phrase to type. Execute stays closed until the person has given every consent and typed the phrase, and
// never opens while a gate blocks or an approval is missing; the engine checks all of it again. The preview names the
// target and the size, never a header value or the body (R7).
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import type { EnginePlan } from '@app/ui-data';
import { TranslocoDirective } from '@jsverse/transloco';

import { controlValue } from './dom';
import { Dialog } from './dialog.component';
import type { ProblemView } from './problem';
import { planNeeds } from './plan-needs';

export interface PlanAnswer {
  readonly consents: readonly string[];
  readonly confirmation: string | undefined;
}

/** What the preview of a publish plan says, field by field; a field the engine did not send is `null`. */
export interface PreviewView {
  readonly exchange: string | null;
  readonly routingKey: string | null;
  readonly copies: number | null;
  readonly bodyBytes: number | null;
  readonly headerCount: number | null;
}

export function previewView(preview: unknown): PreviewView {
  const record =
    typeof preview === 'object' && preview !== null
      ? (preview as Record<string, unknown>)
      : {};
  const text = (name: string): string | null => {
    const value = record[name];
    return typeof value === 'string' ? value : null;
  };
  const count = (name: string): number | null => {
    const value = record[name];
    return typeof value === 'number' ? value : null;
  };
  return {
    exchange: text('exchange'),
    routingKey: text('routingKey'),
    copies: count('copies'),
    bodyBytes: count('bodyBytes'),
    headerCount: count('headerCount'),
  };
}

@Component({
  selector: 'app-plan-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Dialog, TranslocoDirective],
  template: `
    <ng-container *transloco="let t">
      <app-dialog
        [heading]="t('publish.plan.title')"
        [confirmLabel]="t('publish.plan.execute')"
        [cancelLabel]="t('publish.plan.cancel')"
        [busyLabel]="t('publish.plan.busy')"
        [busy]="busy()"
        [confirmClosed]="!canExecute()"
        [problem]="problem()"
        (confirmed)="run()"
        (cancelled)="cancelled.emit()"
      >
        <p>{{ t('publish.plan.intro') }}</p>
        <dl class="preview" data-preview>
          <dt>{{ t('publish.plan.exchange') }}</dt>
          <dd data-field="exchange">
            @if (preview().exchange === null) {
              {{ t('publish.plan.notReported') }}
            } @else if (preview().exchange === '') {
              {{ t('publish.plan.defaultExchange') }}
            } @else {
              {{ preview().exchange }}
            }
          </dd>
          <dt>{{ t('publish.plan.routingKey') }}</dt>
          <dd data-field="routingKey">
            {{ preview().routingKey ?? t('publish.plan.notReported') }}
          </dd>
          <dt>{{ t('publish.plan.copies') }}</dt>
          <dd data-field="copies">
            {{ preview().copies ?? t('publish.plan.notReported') }}
          </dd>
          <dt>{{ t('publish.plan.bodyBytes') }}</dt>
          <dd data-field="bodyBytes">
            {{ preview().bodyBytes ?? t('publish.plan.notReported') }}
          </dd>
          <dt>{{ t('publish.plan.headerCount') }}</dt>
          <dd data-field="headerCount">
            {{ preview().headerCount ?? t('publish.plan.notReported') }}
          </dd>
        </dl>

        @if (needs().blocking.length > 0) {
          <section data-needs="gates" aria-labelledby="plan-gates-title">
            <h3 id="plan-gates-title">{{ t('publish.plan.gates') }}</h3>
            <ul>
              @for (gate of needs().blocking; track $index) {
                <li>
                  <span class="reason">{{
                    gate.reason || t('publish.plan.noReason')
                  }}</span
                  >&ngsp;
                  @if (gate.source) {
                    <span class="source"
                      >{{ t('publish.plan.source') }} {{ gate.source }}</span
                    >&ngsp;
                  }
                  @if (gate.fix; as fix) {
                    <span class="fix"
                      >{{ t('publish.plan.fix') }}
                      <code>{{ fix.actionId }}</code></span
                    >
                  }
                </li>
              }
            </ul>
          </section>
        }

        @if (needs().warnings.length > 0) {
          <section data-needs="warnings" aria-labelledby="plan-warnings-title">
            <h3 id="plan-warnings-title">{{ t('publish.plan.warnings') }}</h3>
            <ul>
              @for (warning of needs().warnings; track $index) {
                <li>
                  <span class="severity">{{ warning.severity }}</span
                  >&ngsp;<code>{{ warning.id }}</code>
                </li>
              }
            </ul>
          </section>
        }

        @if (needs().approvalsMissing > 0) {
          <p data-needs="approvals">
            {{
              t('publish.plan.approvals', { count: needs().approvalsMissing })
            }}
          </p>
        }

        @if (needs().consents.length > 0) {
          <fieldset data-needs="consents">
            <legend>{{ t('publish.plan.consents') }}</legend>
            @for (id of needs().consents; track id) {
              <label class="consent">
                <input
                  type="checkbox"
                  [checked]="given().has(id)"
                  (change)="toggle(id)"
                />
                <code>{{ id }}</code>
              </label>
            }
          </fieldset>
        }

        @if (needs().phrase; as phrase) {
          <div class="phrase" data-needs="phrase">
            <label for="plan-phrase">{{
              t('publish.plan.phrase', { phrase })
            }}</label>
            <input
              id="plan-phrase"
              type="text"
              autocomplete="off"
              spellcheck="false"
              autocapitalize="off"
              [value]="typed()"
              (input)="typed.set(read($event))"
            />
          </div>
        }

        @if (!canExecute()) {
          <p class="closed" data-closed>{{ t('publish.plan.closed') }}</p>
        }
      </app-dialog>
    </ng-container>
  `,
  styles: `
    h3 {
      margin: var(--ds-space-2) 0 var(--ds-space-1);
      font-size: 1em;
    }
    dl {
      display: grid;
      grid-template-columns: max-content minmax(0, 1fr);
      gap: var(--ds-space-1) var(--ds-space-3);
    }
    dt {
      color: var(--ds-color-text-muted);
    }
    dd {
      margin: 0;
      overflow-wrap: anywhere;
    }
    .source,
    .fix,
    .severity {
      margin-inline-start: var(--ds-space-2);
      color: var(--ds-color-text-muted);
    }
    .consent {
      display: flex;
      gap: var(--ds-space-2);
      align-items: center;
      min-height: var(--ds-target-size);
    }
    .phrase {
      display: flex;
      flex-direction: column;
      gap: var(--ds-space-1);
    }
    .closed {
      color: var(--ds-color-text-muted);
    }
  `,
})
export class PlanDialog {
  readonly plan = input.required<EnginePlan>();
  /** The execute call is on its way. */
  readonly busy = input(false);
  /** The failure of the last execute, as received. */
  readonly problem = input<ProblemView | null>(null);

  readonly confirmed = output<PlanAnswer>();
  readonly cancelled = output();

  protected readonly needs = computed(() => planNeeds(this.plan()));
  protected readonly preview = computed(() => previewView(this.plan().preview));
  protected readonly given = signal<ReadonlySet<string>>(new Set());
  protected readonly typed = signal('');

  /** Every consent given, the phrase typed exactly, no blocking gate and no approval missing. */
  protected readonly canExecute = computed(() => {
    const needs = this.needs();
    return (
      needs.blocking.length === 0 &&
      needs.approvalsMissing === 0 &&
      needs.consents.every((id) => this.given().has(id)) &&
      (needs.phrase === null || this.typed() === needs.phrase)
    );
  });

  protected toggle(id: string): void {
    this.given.update((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  protected read(event: Event): string {
    return controlValue(event);
  }

  protected run(): void {
    if (!this.canExecute() || this.busy()) return;
    const phrase = this.needs().phrase;
    this.confirmed.emit({
      consents: this.needs().consents.filter((id) => this.given().has(id)),
      confirmation: phrase === null ? undefined : this.typed(),
    });
  }
}
