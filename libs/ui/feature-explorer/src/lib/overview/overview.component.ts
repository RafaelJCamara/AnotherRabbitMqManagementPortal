// The cluster overview page (M0-54, EXP-02, R9): totals, rates, nodes and alarms of the connection, and the
// freshness of the inventory the sweep-derived totals come from. It reads when it opens and when Refresh is
// pressed (never on a timer), says where every number comes from, and never shows a value the broker did
// not send: an absent total reads "not reported", rates that are off say why and show no number, an alarm
// state that could not be read is unknown and never none. It reads the broker's overview only.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';

import { EXPLORER_CONNECTION } from '../connection';
import { FreshnessBanner } from '../grid/freshness-banner.component';
import { problemView } from '../problem';
import { OverviewAlarmsView } from './alarms.component';
import { OverviewNodes } from './nodes.component';
import { countText, rateText, type OverviewRates } from './overview-model';
import { OverviewStore } from './overview-store';

const DEFAULT_TIME = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
});

let nextPage = 0;

@Component({
  selector: 'app-overview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FreshnessBanner,
    OverviewAlarmsView,
    OverviewNodes,
    TranslocoDirective,
  ],
  providers: [OverviewStore],
  template: `
    <ng-container *transloco="let t">
      @if (connection() !== null) {
        <section class="page">
          <header class="head">
            <h1>{{ t('explorer.overview.title') }}</h1>
            <button
              type="button"
              class="refresh"
              [attr.aria-disabled]="store.refreshClosed() ? 'true' : null"
              [attr.aria-describedby]="store.refreshClosed() ? whyId : null"
              (click)="store.refresh()"
            >
              {{ t('explorer.overview.refresh') }}
            </button>
            @if (store.refreshClosed()) {
              <span class="why" [id]="whyId">{{
                t('explorer.overview.refreshWhy')
              }}</span>
            }
          </header>
          @if (store.status() === 'loading' && !store.answer()) {
            <p class="notice" role="status">
              {{ t('explorer.overview.loading') }}
            </p>
          }
          @if (problem(); as failure) {
            <div class="notice failure" role="alert">
              <p>
                {{
                  t(
                    store.earlier()
                      ? 'explorer.overview.earlier'
                      : 'explorer.overview.failed'
                  )
                }}
              </p>
              <p>
                <span class="problem">{{ failure.title }}</span
                >&ngsp;
                @if (failure.detail) {
                  <span class="problem">{{ failure.detail }}</span>
                }
              </p>
            </div>
          }
          @if (store.answer(); as answer) {
            <dl class="identity">
              <div>
                <dt>{{ t('explorer.overview.product') }}</dt>
                &ngsp;
                <dd>{{ answer.product }}</dd>
              </div>
              @if (answer.version) {
                <div>
                  <dt>{{ t('explorer.overview.version') }}</dt>
                  &ngsp;
                  <dd>{{ answer.version }}</dd>
                </div>
              }
              @if (answer.clusterName) {
                <div>
                  <dt>{{ t('explorer.overview.cluster') }}</dt>
                  &ngsp;
                  <dd>{{ answer.clusterName }}</dd>
                </div>
              }
            </dl>

            <section
              class="region"
              [attr.aria-labelledby]="'ov-totals-' + pageId"
            >
              <h2 [id]="'ov-totals-' + pageId">
                {{ t('explorer.overview.totals.title') }}
              </h2>
              <dl class="totals">
                @for (name of counted; track name) {
                  <div>
                    <dt>{{ t('explorer.overview.totals.' + name) }}</dt>
                    &ngsp;
                    <dd>
                      {{
                        count(answer.totals[name]) ??
                          t('explorer.overview.notReported')
                      }}
                    </dd>
                  </div>
                }
              </dl>
              <h3 [id]="'ov-messages-' + pageId">
                {{ t('explorer.overview.messages.title') }}
              </h3>
              @if (answer.totals.messages; as messages) {
                <dl
                  class="totals"
                  [attr.aria-labelledby]="'ov-messages-' + pageId"
                >
                  <div>
                    <dt>{{ t('explorer.overview.messages.total') }}</dt>
                    &ngsp;
                    <dd>{{ count(messages.total) }}</dd>
                  </div>
                  <div>
                    <dt>{{ t('explorer.overview.messages.ready') }}</dt>
                    &ngsp;
                    <dd>{{ count(messages.ready) }}</dd>
                  </div>
                  <div>
                    <dt>
                      {{ t('explorer.overview.messages.unacknowledged') }}
                    </dt>
                    &ngsp;
                    <dd>{{ count(messages.unacknowledged) }}</dd>
                  </div>
                </dl>
                <p class="source">
                  {{
                    t('explorer.overview.messages.source.' + messages.source)
                  }}
                  {{
                    t('explorer.overview.messages.asOf', {
                      time: time()(messages.asOf),
                    })
                  }}
                </p>
                @if (!messages.complete) {
                  <p class="partial">
                    {{ t('explorer.overview.messages.partial') }}
                  </p>
                }
              } @else {
                <p>{{ t('explorer.overview.notReported') }}</p>
              }
            </section>

            <section
              class="region"
              [attr.aria-labelledby]="'ov-rates-' + pageId"
            >
              <h2 [id]="'ov-rates-' + pageId">
                {{ t('explorer.overview.rates.title') }}
              </h2>
              @if (answer.rates.state === 'available') {
                <dl class="totals">
                  <div>
                    <dt>{{ t('explorer.overview.rates.publish') }}</dt>
                    &ngsp;
                    <dd>
                      {{
                        rate(publish(answer.rates)) ??
                          t('explorer.overview.notReported')
                      }}
                    </dd>
                  </div>
                  <div>
                    <dt>{{ t('explorer.overview.rates.deliver') }}</dt>
                    &ngsp;
                    <dd>
                      {{
                        rate(deliver(answer.rates)) ??
                          t('explorer.overview.notReported')
                      }}
                    </dd>
                  </div>
                </dl>
              } @else {
                <p class="unavailable">
                  {{
                    t(
                      'explorer.overview.rates.unavailable.' +
                        unavailable(answer.rates)
                    )
                  }}
                </p>
              }
            </section>

            <section
              class="region"
              [attr.aria-labelledby]="'ov-nodes-' + pageId"
            >
              <h2 [id]="'ov-nodes-' + pageId">
                {{ t('explorer.overview.nodes.title') }}
              </h2>
              <app-overview-nodes [nodes]="answer.nodes" />
            </section>

            <section
              class="region"
              [attr.aria-labelledby]="'ov-alarms-' + pageId"
            >
              <h2 [id]="'ov-alarms-' + pageId">
                {{ t('explorer.overview.alarms.title') }}
              </h2>
              <app-overview-alarms [alarms]="answer.alarms" />
            </section>

            <section
              class="region"
              [attr.aria-labelledby]="'ov-fresh-' + pageId"
            >
              <h2 [id]="'ov-fresh-' + pageId">
                {{ t('explorer.overview.freshness') }}
              </h2>
              <app-freshness-banner
                kind="queues"
                [freshness]="answer.freshness"
                [state]="null"
                [time]="time()"
              />
            </section>
          }
        </section>
      }
    </ng-container>
  `,
  styles: `
    :host {
      display: block;
      height: 100%;
      overflow: auto;
    }
    .page {
      display: flex;
      flex-direction: column;
      gap: var(--ds-space-3);
      padding: var(--ds-space-3);
    }
    .head {
      display: flex;
      align-items: baseline;
      gap: var(--ds-space-3);
    }
    h1,
    h2,
    h3 {
      margin: 0;
    }
    h2 {
      font-size: var(--ds-font-size-lg, 1.2em);
    }
    h3 {
      font-size: var(--ds-font-size);
    }
    .refresh {
      min-height: var(--ds-target-size);
      padding: 0 var(--ds-space-3);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      background: var(--ds-color-surface);
      color: var(--ds-color-text);
      font: inherit;
      cursor: pointer;
    }
    .refresh[aria-disabled='true'] {
      border-style: dashed;
      color: var(--ds-color-text-muted);
      cursor: not-allowed;
    }
    .refresh:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: 2px;
    }
    .why,
    .notice,
    .source {
      color: var(--ds-color-text-muted);
    }
    .failure {
      border-inline-start: 3px solid var(--ds-color-text-danger);
      padding-inline-start: var(--ds-space-3);
    }
    .region {
      display: flex;
      flex-direction: column;
      gap: var(--ds-space-2);
    }
    .identity,
    .totals {
      display: flex;
      flex-wrap: wrap;
      gap: var(--ds-space-4, 1rem);
      margin: 0;
    }
    dt {
      color: var(--ds-color-text-muted);
      font-size: var(--ds-font-size);
    }
    dd {
      margin: 0;
      font-weight: 600;
    }
    p {
      margin: 0;
    }
  `,
})
export class OverviewPage {
  /** Formats the time the message totals describe; the document language by default. */
  readonly time = input<(epochMs: number) => string>((ms) =>
    DEFAULT_TIME.format(ms),
  );

  protected readonly connection = inject(EXPLORER_CONNECTION);
  protected readonly store = inject(OverviewStore);
  protected readonly pageId = String(nextPage++);
  protected readonly whyId = `ov-why-${this.pageId}`;
  protected readonly counted = [
    'queues',
    'exchanges',
    'connections',
    'channels',
    'consumers',
  ] as const;
  protected readonly problem = computed(() => {
    const error = this.store.error();
    return error === null ? null : problemView(error);
  });

  protected count(value: number | undefined): string | null {
    return countText(value);
  }

  protected rate(value: number | undefined): string | null {
    return rateText(value);
  }

  protected publish(rates: OverviewRates): number | undefined {
    return rates.state === 'available' ? rates.publishPerSec : undefined;
  }

  protected deliver(rates: OverviewRates): number | undefined {
    return rates.state === 'available' ? rates.deliverPerSec : undefined;
  }

  protected unavailable(rates: OverviewRates): string {
    return rates.state === 'unavailable' ? rates.reason : 'not-reported';
  }
}
