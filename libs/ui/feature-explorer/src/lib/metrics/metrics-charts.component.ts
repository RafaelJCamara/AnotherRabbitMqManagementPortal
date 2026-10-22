// The metrics panel of a page (M1-54, MON-02, MON-05): the charts of a queue (its Charts tab), the drain forecast of a
// queue (its Forecast tab) and the trends of the cluster (the overview), with the controls (time range, vertical
// scale, pause, read again), what the engine said about its source and every gap, and the failure with the
// engine's Problem as sent. It reads through `metrics.query`, `metrics.forecast` and `metrics.live` only: nothing here
// changes the broker. A series the engine does not hold is "not reported", never zero.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import {
  clusterCharts,
  DEFAULT_RANGE,
  domainOf,
  explainStatus,
  queueCharts,
  RANGES,
  rangeOf,
  seriesOf,
  type SessionConfig,
} from '@app/metrics-model';
import type { YScaleKind } from '@app/ui-charts';
import { TranslocoDirective } from '@jsverse/transloco';

import { EXPLORER_CONNECTION } from '../connection';
import { hintKey, problemView } from '../problem';
import type { Translate } from '../translate';
import { ChartCard } from './chart-card.component';
import { ForecastDetails } from './forecast-details.component';
import { injectForecast, type ForecastTarget } from './forecast-store';
import { formatDuration, formatTime } from './metrics-format';
import { injectMetricsRead } from './metrics-store';
import { explainText } from './metrics-text';

export type MetricsMode = 'cluster' | 'queue' | 'forecast';

let nextPanel = 0;

@Component({
  selector: 'app-metrics-charts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartCard, ForecastDetails, TranslocoDirective],
  template: `
    <ng-container *transloco="let t">
      @if (connection() !== null) {
        <section class="panel" [attr.aria-labelledby]="id">
          <h2 [id]="id">{{ t('explorer.metrics.title.' + mode()) }}</h2>
          <div
            class="controls"
            role="group"
            [attr.aria-label]="t('explorer.metrics.controls.group')"
          >
            <label>
              <span>{{ t('explorer.metrics.controls.range') }}</span>
              <select class="range" (change)="setRange($event)">
                @for (option of ranges; track option.id) {
                  <option
                    [value]="option.id"
                    [selected]="option.id === range()"
                  >
                    {{ t('explorer.metrics.range.' + option.id) }}
                  </option>
                }
                <option disabled>
                  {{ t('explorer.metrics.range.later') }}
                </option>
              </select>
            </label>
            <label>
              <span>{{ t('explorer.metrics.controls.scale') }}</span>
              <select class="scale" (change)="setScale($event)">
                @for (option of scales; track option) {
                  <option [value]="option" [selected]="option === scale()">
                    {{ t('explorer.metrics.scale.' + option) }}
                  </option>
                }
              </select>
            </label>
            <button
              type="button"
              class="pause"
              [attr.aria-pressed]="paused()"
              (click)="togglePause()"
            >
              {{
                paused()
                  ? t('explorer.metrics.controls.resume')
                  : t('explorer.metrics.controls.pause')
              }}
            </button>
            <button type="button" class="reload" (click)="read.reload()">
              {{ t('explorer.metrics.controls.refresh') }}
            </button>
          </div>

          <div class="state" role="status">
            @if (state(); as s) {
              @if (s.phase === 'loading') {
                <p>{{ t('explorer.metrics.status.loading') }}</p>
              } @else if (s.live === 'connecting') {
                <p>{{ t('explorer.metrics.status.connecting') }}</p>
              }
              @if (s.paused) {
                <p class="warn">
                  {{
                    t('explorer.metrics.status.paused', { count: s.waiting })
                  }}
                </p>
              }
              @if (s.live === 'ended') {
                <p class="warn">
                  {{ t('explorer.metrics.status.liveEnded') }}
                  @if (liveProblem(); as ended) {
                    <span class="problem">{{ ended.title }}</span>
                    @if (ended.detail) {
                      <span class="problem">{{ ended.detail }}</span>
                    }
                  }
                </p>
              }
              @if (source(t); as line) {
                <p class="source">{{ line }}</p>
              }
              @for (item of explanations(); track $index) {
                <p class="explain" [attr.data-code]="item.code">
                  {{ explain(item, t) }}
                </p>
              }
              @if (evicted() > 0) {
                <p class="warn">
                  {{
                    t('explorer.metrics.status.evicted', { count: evicted() })
                  }}
                </p>
              }
              @if (s.gaps > 0) {
                <p class="warn">
                  {{ t('explorer.metrics.status.gaps', { count: s.gaps }) }}
                </p>
              }
            }
            @if (omittedNodes() > 0) {
              <p class="warn">
                {{
                  t('explorer.metrics.status.omitted', {
                    count: omittedNodes(),
                  })
                }}
              </p>
            }
          </div>

          @if (failure(); as problem) {
            <div class="failure" role="alert">
              <p>{{ t('explorer.metrics.status.failed') }}</p>
              <p>
                <span class="problem">{{ problem.title }}</span>
                @if (problem.detail) {
                  <span class="problem">{{ problem.detail }}</span>
                }
              </p>
              @if (hint(problem.code); as key) {
                <p class="hint">{{ t(key) }}</p>
              }
              <button type="button" class="retry" (click)="read.reload()">
                {{ t('explorer.metrics.status.retry') }}
              </button>
            </div>
          }

          @if (state(); as s) {
            <div class="cards">
              @for (chart of charts(); track chart.id) {
                <app-chart-card
                  [chart]="chart"
                  [state]="s"
                  [domain]="domain()"
                  [scale]="scale()"
                  [forecast]="forecast.read()?.view ?? null"
                  [explanations]="explanations()"
                />
              }
            </div>
          }
          @if (forecastTarget() !== null) {
            <app-forecast-details
              [read]="forecast.read()"
              [compact]="mode() !== 'forecast'"
              (refresh)="forecast.refresh()"
            />
          }
        </section>
      }
    </ng-container>
  `,
  styles: `
    :host {
      display: block;
    }
    .panel {
      display: flex;
      flex-direction: column;
      gap: var(--ds-space-3);
    }
    h2,
    p {
      margin: 0;
    }
    h2 {
      font-size: var(--ds-font-size-lg, 1.2em);
    }
    .controls {
      display: flex;
      flex-wrap: wrap;
      align-items: end;
      gap: var(--ds-space-3);
    }
    label {
      display: flex;
      flex-direction: column;
      gap: var(--ds-space-1);
      color: var(--ds-color-text-muted);
    }
    select,
    button {
      min-height: var(--ds-target-size);
      padding: 0 var(--ds-space-3);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      background: var(--ds-color-surface);
      color: var(--ds-color-text);
      font: inherit;
    }
    button {
      cursor: pointer;
    }
    button[aria-pressed='true'] {
      border-width: 2px;
      font-weight: 600;
    }
    select:focus-visible,
    button:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: 2px;
    }
    .state {
      display: flex;
      flex-direction: column;
      gap: var(--ds-space-1);
    }
    .state:empty {
      display: none;
    }
    .source,
    .explain,
    .hint {
      color: var(--ds-color-text-muted);
    }
    .warn,
    .failure {
      padding-inline-start: var(--ds-space-3);
      border-inline-start: 4px solid var(--ds-color-warning);
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr));
      gap: var(--ds-space-3);
    }
  `,
})
export class MetricsCharts {
  /** `cluster`: the trends of the overview; `queue`: the Charts tab of a queue; `forecast`: its Forecast tab. */
  readonly mode = input.required<MetricsMode>();
  /** The queue (modes `queue` and `forecast`). */
  readonly vhost = input('');
  readonly name = input('');
  /** The node names (mode `cluster`): memory and disk are drawn per node. */
  readonly nodes = input<readonly string[]>([]);

  protected readonly connection = inject(EXPLORER_CONNECTION);
  protected readonly id = `metrics-${String(nextPanel++)}`;
  protected readonly ranges = RANGES;
  protected readonly scales: readonly YScaleKind[] = ['zero', 'fit', 'log'];
  protected readonly explain = explainText;
  protected readonly hint = hintKey;

  protected readonly range = signal<string>(DEFAULT_RANGE);
  protected readonly scale = signal<YScaleKind>('zero');

  readonly #plan = computed(() => {
    if (this.mode() === 'cluster') return clusterCharts(this.nodes());
    const all = queueCharts({ vhost: this.vhost(), name: this.name() });
    return {
      charts: this.mode() === 'forecast' ? all.slice(0, 1) : all,
      omittedNodes: 0,
    };
  });
  protected readonly charts = computed(() => this.#plan().charts);
  protected readonly omittedNodes = computed(() => this.#plan().omittedNodes);

  readonly #config = computed<SessionConfig | null>(() => {
    const cid = this.connection();
    const series = seriesOf(this.charts());
    if (cid === null || series.length === 0) return null;
    return {
      cid,
      series,
      queues:
        this.mode() === 'cluster'
          ? []
          : [{ vhost: this.vhost(), name: this.name() }],
    };
  });
  protected readonly read = injectMetricsRead(this.#config);
  protected readonly state = this.read.state;
  protected readonly paused = computed(() => this.state()?.paused ?? false);

  protected readonly forecastTarget = computed<ForecastTarget | null>(() => {
    if (this.connection() === null) return null;
    return this.mode() === 'cluster'
      ? { scope: 'cluster' }
      : { scope: 'queue', vhost: this.vhost(), name: this.name() };
  });
  protected readonly forecast = injectForecast(
    this.forecastTarget,
    this.paused,
  );

  protected readonly domain = computed(() =>
    domainOf(this.state()?.newestT ?? null, rangeOf(this.range()).ms),
  );
  protected readonly explanations = computed(() =>
    explainStatus(this.state()?.status ?? null),
  );
  protected readonly evicted = computed(() =>
    (this.state()?.series ?? []).reduce((sum, s) => sum + s.evicted, 0),
  );
  /** The failure of the history read, as the engine sent it. */
  protected readonly failure = computed(() => {
    const problem = this.state()?.problem;
    return problem === null || problem === undefined
      ? null
      : problemView(problem);
  });
  protected readonly liveProblem = computed(() => {
    const problem = this.state()?.liveProblem;
    return problem === null || problem === undefined
      ? null
      : problemView(problem);
  });

  /** Where the numbers come from and how often they are collected, as the engine said. */
  protected source(t: Translate): string {
    const status = this.state()?.status;
    if (status === undefined || status === null) return '';
    const parts = [
      t('explorer.metrics.status.source', {
        source: t(`explorer.metrics.source.${status.source}`),
      }),
    ];
    if (status.intervalMs !== undefined) {
      parts.push(
        t('explorer.metrics.status.interval', {
          interval: formatDuration(status.intervalMs),
        }),
      );
    }
    const newest = this.state()?.newestT;
    if (newest !== null && newest !== undefined) {
      parts.push(
        t('explorer.metrics.status.newest', { time: formatTime(newest) }),
      );
    }
    return parts.join(' ');
  }

  protected setRange(event: Event): void {
    this.range.set((event.target as HTMLSelectElement).value);
  }

  protected setScale(event: Event): void {
    this.scale.set((event.target as HTMLSelectElement).value as YScaleKind);
  }

  protected togglePause(): void {
    if (this.paused()) this.read.resume();
    else this.read.pause();
  }
}
