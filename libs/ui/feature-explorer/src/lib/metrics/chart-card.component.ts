// One chart of a page (M1-54): its heading, the line chart with its legend, cursor and data table, the words for
// every line (a series the engine does not report says why) and, when no line has a point, the reasons the
// engine gave, so no chart is silently empty. Texts and units are made here and handed to the presentational
// chart.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import {
  chartData,
  type ChartDef,
  type Explanation,
  type ForecastView,
  type SessionState,
} from '@app/metrics-model';
import { formatValue, type YScaleKind } from '@app/chart-math';
import { LineChart, type ChartLabels, type ChartSeries } from '@app/ui-charts';
import { TranslocoDirective } from '@jsverse/transloco';

import type { Translate } from '../translate';
import { chartLabels, explainText, reasonKey } from './metrics-text';

let nextCard = 0;

@Component({
  selector: 'app-chart-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LineChart, TranslocoDirective],
  template: `
    <ng-container *transloco="let t">
      <section class="card" [attr.aria-labelledby]="id">
        <h3 [id]="id">{{ t('explorer.metrics.chart.' + chart().id) }}</h3>
        @if (chart().lines.length === 0) {
          <p class="gap" role="status">
            {{ t('explorer.metrics.status.noNodes') }}
          </p>
        } @else {
          @if (nothingDrawn()) {
            <div class="gap" role="status">
              <p>{{ t('explorer.metrics.explain.absentChart') }}</p>
              @for (item of explanations(); track $index) {
                <p data-reason [attr.data-code]="item.code">
                  {{ explain(item, t) }}
                </p>
              }
            </div>
          }
          <app-line-chart
            [title]="title(t)"
            [series]="series(t)"
            [domain]="domain()"
            [labels]="labels(t)"
            [yScale]="scale()"
            [kind]="kind()"
            [forecast]="overlay()"
            [forecastSeries]="chart().forecastAnchor"
            [summary]="summary(t)"
            [height]="180"
          />
        }
      </section>
    </ng-container>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .card {
      display: flex;
      flex-direction: column;
      gap: var(--ds-space-2);
      padding: var(--ds-space-3);
      border: 1px solid var(--ds-color-border);
      border-radius: var(--ds-radius);
      background: var(--ds-color-surface);
    }
    h3,
    p {
      margin: 0;
    }
    h3 {
      font-size: var(--ds-font-size);
    }
    .gap {
      padding-inline-start: var(--ds-space-3);
      border-inline-start: 4px solid var(--ds-color-warning);
      color: var(--ds-color-text);
    }
  `,
})
export class ChartCard {
  readonly chart = input.required<ChartDef>();
  readonly state = input.required<SessionState>();
  readonly domain = input.required<{
    readonly from: number;
    readonly to: number;
  }>();
  readonly scale = input<YScaleKind>('zero');
  /** The forecast of the page, drawn on the chart that has the depth. */
  readonly forecast = input<ForecastView | null>(null);
  /** What the engine said about its status, shown when this chart has nothing to draw. */
  readonly explanations = input<readonly Explanation[]>([]);

  protected readonly id = `card-${String(nextCard++)}`;
  protected readonly explain = explainText;

  readonly #lines = computed(() => chartData(this.chart(), this.state()));
  protected readonly nothingDrawn = computed(() =>
    this.#lines().every((line) => line.state !== 'drawn'),
  );
  /** The overlay is for an `ok` forecast of the chart that has the depth. */
  protected readonly overlay = computed(() => {
    const view = this.forecast();
    return this.chart().forecastAnchor !== null && view?.state === 'ok'
      ? { etaMs: view.etaMs, lowMs: view.lowMs, highMs: view.highMs }
      : null;
  });

  #titleFor: Translate | null = null;
  #title = '';
  #labelsFor: Translate | null = null;
  #labels: ChartLabels | null = null;

  protected title(t: Translate): string {
    if (this.#titleFor !== t) {
      this.#titleFor = t;
      this.#title = t(`explorer.metrics.chart.${this.chart().id}`);
    }
    return this.#title;
  }

  protected labels(t: Translate): ChartLabels {
    const title = this.title(t);
    if (this.#labelsFor !== t || this.#labels === null) {
      this.#labelsFor = t;
      this.#labels = chartLabels(t, title);
    }
    return this.#labels;
  }

  /** Depth is drawn as an area, the rest as lines. */
  protected readonly kind = computed<'area' | 'line'>(() =>
    this.chart().forecastAnchor === null ? 'line' : 'area',
  );

  /** The lines as the chart takes them; a new array only when the data or the language changed. */
  #seriesLines: unknown = null;
  #seriesFor: Translate | null = null;
  #seriesValue: ChartSeries[] = [];
  protected series(t: Translate): ChartSeries[] {
    const lines = this.#lines();
    if (this.#seriesLines === lines && this.#seriesFor === t) {
      return this.#seriesValue;
    }
    const status = this.state().status;
    const chart = this.chart();
    this.#seriesLines = lines;
    this.#seriesFor = t;
    this.#seriesValue = lines.map((line): ChartSeries => {
      const name = t(`explorer.metrics.series.${line.def.metric}`);
      return {
        id: line.def.id,
        label:
          line.def.node === undefined
            ? name
            : t('explorer.metrics.seriesNode', { name, node: line.def.node }),
        unit: chart.unit,
        style: line.def.style,
        points: line.points,
        state: line.state === 'drawn' ? 'drawn' : 'not-reported',
        ...(line.state === 'drawn'
          ? {}
          : { reason: t(reasonKey(line, status)) }),
        approximate: line.approximate,
      };
    });
    return this.#seriesValue;
  }

  /**
   * The text of the live region: the newest values and the states that matter. It is made again only when the
   * session's summary changes (at most once per 15 s of data time, or on a state change), not on every point.
   */
  #summaryOf: SessionState['summary'] | null = null;
  #summaryFor: Translate | null = null;
  #summary = '';
  protected summary(t: Translate): string {
    const summary = this.state().summary;
    if (this.#summaryOf !== summary || this.#summaryFor !== t) {
      this.#summaryOf = summary;
      this.#summaryFor = t;
      this.#summary = this.#summaryText(summary, t);
    }
    return this.#summary;
  }
  #summaryText(summary: SessionState['summary'], t: Translate): string {
    const chart = this.chart();
    const title = t(`explorer.metrics.chart.${chart.id}`);
    const lines = this.#lines().filter((line) => line.state === 'drawn');
    const last = (points: readonly { v: number }[]): number | undefined =>
      points[points.length - 1]?.v;
    const values = lines
      .flatMap((line) => {
        const value = last(line.points);
        if (value === undefined) return [];
        const name = t(`explorer.metrics.series.${line.def.metric}`);
        return [`${name} ${formatValue(value, chart.unit)}`];
      })
      .join(', ');
    const parts = [
      values === ''
        ? t('explorer.metrics.summary.none', { title })
        : t('explorer.metrics.summary.values', { title, values }),
    ];
    if (summary.paused) parts.push(t('explorer.metrics.summary.paused'));
    if (summary.live === 'ended')
      parts.push(t('explorer.metrics.summary.ended'));
    return parts.join(' ');
  }
}
