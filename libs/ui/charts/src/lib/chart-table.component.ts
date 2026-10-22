// The data table alternative of a chart (M1-54, R7): the same numbers as a real table, newest first, at most 100
// rows (the rest are counted), a missing value said and never shown as zero. It sits in a `<details>`; the rows are
// built only while it is open, so a page of charts does not build a table nobody looks at.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  signal,
} from '@angular/core';

import type { ChartLabels, ChartSeries } from './chart-types';
import { formatClock, formatValue } from './draw/format';

/** The most rows the table shows. */
export const TABLE_ROWS_MAX = 100;

interface Row {
  readonly t: number;
  readonly time: string;
  readonly cells: readonly string[];
}

@Component({
  selector: 'app-chart-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <details class="alt" (toggle)="onToggle($event)">
      <summary>{{ labels().tableSummary }}</summary>
      @if (open()) {
        <table>
          <caption>
            {{
              labels().tableCaption
            }}
          </caption>
          <thead>
            <tr>
              <th scope="col">{{ labels().timeColumn }}</th>
              @for (column of columns(); track column.id) {
                <th scope="col">{{ column.label }}</th>
              }
            </tr>
          </thead>
          <tbody>
            @for (row of rows().shown; track row.t) {
              <tr>
                <th scope="row">{{ row.time }}</th>
                @for (cell of row.cells; track $index) {
                  <td>{{ cell }}</td>
                }
              </tr>
            }
          </tbody>
        </table>
        @if (rows().older > 0) {
          <p class="older">{{ labels().olderRows(rows().older) }}</p>
        }
      }
    </details>
  `,
  styles: `
    :host {
      display: block;
    }
    summary {
      cursor: pointer;
      min-height: var(--ds-target-size);
      color: var(--ds-color-text-link);
    }
    summary:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: 2px;
    }
    table {
      border-collapse: collapse;
      font-size: var(--ds-font-size);
    }
    caption {
      text-align: start;
      color: var(--ds-color-text-muted);
    }
    th,
    td {
      padding: 2px var(--ds-space-3);
      border-block-end: 1px solid var(--ds-color-border);
      text-align: end;
      font-variant-numeric: tabular-nums;
    }
    th:first-child,
    thead th {
      text-align: start;
    }
    .older {
      margin: var(--ds-space-1) 0 0;
      color: var(--ds-color-text-muted);
    }
  `,
})
export class ChartTable {
  readonly series = input.required<readonly ChartSeries[]>();
  readonly labels = input.required<ChartLabels>();
  readonly locale = input<string | undefined>(undefined);
  /** Only the rows at or after this time (the chart's visible range); `null` for all. */
  readonly from = input<number | null>(null);

  protected readonly open = signal(false);
  protected readonly columns = computed(() => this.series());

  protected readonly rows = computed(() => {
    if (!this.open()) return { shown: [] as Row[], older: 0 };
    const from = this.from();
    const labels = this.labels();
    const locale = this.locale();
    const times = new Set<number>();
    const byTime = this.series().map((series) => {
      const map = new Map<number, number>();
      if (series.state === 'drawn') {
        for (const point of series.points) {
          if ((from === null || point.t >= from) && Number.isFinite(point.v)) {
            map.set(point.t, point.v);
            times.add(point.t);
          }
        }
      }
      return map;
    });
    const ordered = [...times].sort((a, b) => b - a);
    const shown = ordered.slice(0, TABLE_ROWS_MAX).map(
      (t): Row => ({
        t,
        time: formatClock(t, locale),
        cells: this.series().map((series, index) => {
          if (series.state !== 'drawn') return labels.notReported;
          const value = byTime[index]?.get(t);
          return value === undefined
            ? labels.noPoint
            : formatValue(value, series.unit, locale);
        }),
      }),
    );
    return { shown, older: Math.max(0, ordered.length - TABLE_ROWS_MAX) };
  });

  protected onToggle(event: Event): void {
    this.open.set((event.target as HTMLDetailsElement).open);
  }
}
