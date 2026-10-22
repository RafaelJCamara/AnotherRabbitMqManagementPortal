// The line and area chart (M1-54): SVG drawn from the pure maths of `./draw`, bounded to four vertices per pixel
// column, broken at gaps, with a legend of toggles, a keyboard-operable time cursor, an optional forecast overlay
// and a data table alternative. A series the engine does not report is listed with its reason and drawn as
// nothing. No animation or transition is used, so a chart never moves by itself and `prefers-reduced-motion` is
// honoured by construction.
//
// Accessibility: the plot is a horizontal `slider` over the points of the first visible series, so Left and Right,
// PageUp and PageDown, Home and End and Escape do what the platform's own sliders do, and the value text is the
// readout (time, then each visible series and its value). A pointer hover shows the same readout and changes
// nothing a screen reader is told. The host passes a throttled summary for the live region.
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';

import { ChartTable } from './chart-table.component';
import {
  markerPath,
  styleOf,
  type ChartLabels,
  type ChartSeries,
  type MarkerShape,
} from './chart-types';
import { downsample } from './draw/downsample';
import { formatClock, formatValue } from './draw/format';
import {
  forecastOverlay,
  withOverlayRoom,
  type OverlayForecast,
} from './draw/overlay';
import { areaOf, gapThreshold, pathOf } from './draw/path';
import { atOrBefore, nearestIndex, stepCursor } from './draw/pick';
import { linearScale, yAxis, type YScaleKind } from './draw/scales';
import { timeTicks } from './draw/time-ticks';

let nextChart = 0;

const MARGIN = { left: 56, right: 12, top: 8, bottom: 24 } as const;
/** The width used when nothing can be measured (a test, or a first paint). */
const DEFAULT_WIDTH = 640;
const filled = (shape: MarkerShape): boolean =>
  shape !== 'ring' && shape !== 'cross';

@Component({
  selector: 'app-line-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartTable],
  template: `
    <figure class="chart">
      <div class="legend" role="group" [attr.aria-label]="labels().legend">
        @for (item of legend(); track item.id) {
          @if (item.reported) {
            <button
              type="button"
              class="legend-item"
              [attr.aria-pressed]="!item.hidden"
              (click)="toggle(item.id)"
            >
              <svg
                class="swatch"
                viewBox="0 0 28 12"
                width="28"
                height="12"
                aria-hidden="true"
              >
                <line
                  x1="1"
                  y1="6"
                  x2="27"
                  y2="6"
                  [style.stroke]="item.colour"
                  [attr.stroke-dasharray]="item.dash || null"
                />
                <path
                  [attr.d]="item.swatch"
                  [style.stroke]="item.colour"
                  [style.fill]="item.filled ? item.colour : 'none'"
                />
              </svg>
              <span class="name">{{ item.label }}</span>
              @if (item.approximate) {
                <span class="approx">{{ labels().approximate }}</span>
              }
            </button>
          } @else {
            <span class="legend-item off">
              <svg
                class="swatch"
                viewBox="0 0 28 12"
                width="28"
                height="12"
                aria-hidden="true"
              >
                <line
                  x1="1"
                  y1="6"
                  x2="27"
                  y2="6"
                  class="none"
                  stroke-dasharray="1 3"
                />
              </svg>
              <span class="name">{{ item.label }}</span>
              <span class="why">{{ notReportedText(item) }}</span>
            </span>
          }
        }
      </div>

      @if (hasData()) {
        <div
          class="plot"
          role="slider"
          tabindex="0"
          aria-orientation="horizontal"
          [attr.aria-label]="title()"
          [attr.aria-describedby]="id + '-hint'"
          [attr.aria-valuemin]="0"
          [attr.aria-valuemax]="cursorPoints().length - 1"
          [attr.aria-valuenow]="cursorIndex() ?? cursorPoints().length - 1"
          [attr.aria-valuetext]="keyboardReadout() ?? summary()"
          (keydown)="onKey($event)"
          (pointermove)="onPointer($event)"
          (pointerleave)="onLeave()"
        >
          <svg
            class="svg"
            aria-hidden="true"
            focusable="false"
            [attr.viewBox]="'0 0 ' + totalWidth() + ' ' + height()"
          >
            <g
              [attr.transform]="
                'translate(' + margin.left + ' ' + margin.top + ')'
              "
            >
              @for (tick of yTicks(); track tick.y) {
                <line
                  class="grid"
                  x1="0"
                  [attr.x2]="plotWidth()"
                  [attr.y1]="tick.y"
                  [attr.y2]="tick.y"
                />
                <text
                  class="tick"
                  text-anchor="end"
                  x="-6"
                  [attr.y]="tick.y + 4"
                >
                  {{ tick.label }}
                </text>
              }
              @for (tick of xTicks(); track tick.t) {
                <line
                  class="grid"
                  [attr.x1]="tick.x"
                  [attr.x2]="tick.x"
                  y1="0"
                  [attr.y2]="plotHeight()"
                />
                <text
                  class="tick"
                  text-anchor="middle"
                  [attr.x]="tick.x"
                  [attr.y]="plotHeight() + 16"
                >
                  {{ tick.label }}
                </text>
              }
              @if (overlay(); as o) {
                @if (o.band; as band) {
                  <rect
                    class="band"
                    [attr.x]="band.x"
                    y="0"
                    [attr.width]="band.width"
                    [attr.height]="plotHeight()"
                  />
                }
                @if (o.eta !== null) {
                  <line
                    class="eta"
                    [attr.x1]="o.eta"
                    [attr.x2]="o.eta"
                    y1="0"
                    [attr.y2]="plotHeight()"
                  />
                }
                <line
                  class="drain"
                  [attr.x1]="o.x1"
                  [attr.y1]="o.y1"
                  [attr.x2]="o.x2"
                  [attr.y2]="o.y2"
                />
              }
              @for (line of lines(); track line.id) {
                @if (line.area) {
                  <path
                    class="area"
                    [attr.d]="line.area"
                    [style.fill]="line.colour"
                  />
                }
                <path
                  class="line"
                  [attr.d]="line.d"
                  [style.stroke]="line.colour"
                  [attr.stroke-dasharray]="line.dash || null"
                />
                @if (line.marker) {
                  <path
                    class="marker"
                    [attr.d]="line.marker"
                    [style.stroke]="line.colour"
                    [style.fill]="line.filled ? line.colour : 'none'"
                  />
                }
              }
              @if (cursor(); as c) {
                <line
                  class="cursor"
                  [attr.x1]="c.x"
                  [attr.x2]="c.x"
                  y1="0"
                  [attr.y2]="plotHeight()"
                />
                @for (dot of c.dots; track dot.id) {
                  <path
                    class="marker"
                    [attr.d]="dot.d"
                    [style.stroke]="dot.colour"
                    [style.fill]="dot.filled ? dot.colour : 'none'"
                  />
                }
              }
            </g>
          </svg>
          @if (shownReadout(); as readout) {
            <div class="readout" aria-hidden="true">{{ readout }}</div>
          }
        </div>
        @if (overlay(); as o) {
          <p class="forecast-note">
            {{ labels().forecastDrawn }}
            @if (o.beyond) {
              {{ labels().forecastBeyond }}
            }
          </p>
        }
      } @else {
        <p class="empty" role="status">{{ labels().noData }}</p>
      }
      <p [id]="id + '-hint'" class="sr-only">{{ labels().keyboardHint }}</p>
      <div class="sr-only" aria-live="polite" aria-atomic="true">
        {{ summary() }}
      </div>
      <app-chart-table
        [series]="series()"
        [labels]="labels()"
        [locale]="locale()"
        [from]="domain().from"
      />
    </figure>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .chart {
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: var(--ds-space-1);
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: var(--ds-space-1) var(--ds-space-3);
    }
    .legend-item {
      display: inline-flex;
      align-items: center;
      gap: var(--ds-space-1);
      min-height: var(--ds-target-size);
      padding: 0 var(--ds-space-2);
      border: 1px solid var(--ds-color-border);
      border-radius: var(--ds-radius);
      background: var(--ds-color-surface);
      color: var(--ds-color-text);
      font: inherit;
    }
    button.legend-item {
      cursor: pointer;
    }
    button.legend-item[aria-pressed='false'] {
      border-style: dashed;
      color: var(--ds-color-text-muted);
      text-decoration: line-through;
    }
    .legend-item.off {
      border-style: dotted;
      color: var(--ds-color-text-muted);
    }
    .legend-item:focus-visible,
    .plot:focus-visible {
      outline: var(--ds-focus-ring-width) solid var(--ds-color-focus-ring);
      outline-offset: 2px;
    }
    .swatch line,
    .swatch path {
      stroke-width: 2;
    }
    .swatch .none {
      stroke: var(--ds-color-text-muted);
    }
    .approx,
    .why {
      color: var(--ds-color-text-muted);
      font-size: 0.9em;
    }
    .plot {
      position: relative;
    }
    .svg {
      display: block;
      width: 100%;
      height: auto;
    }
    .grid {
      stroke: var(--ds-color-border);
      stroke-width: 1;
    }
    .tick {
      fill: var(--ds-color-text-muted);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
    }
    .line {
      fill: none;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .area {
      stroke: none;
      fill-opacity: 0.14;
    }
    .marker {
      stroke-width: 1.5;
    }
    .cursor {
      stroke: var(--ds-color-text);
      stroke-width: 1;
      stroke-dasharray: 2 2;
    }
    .band {
      fill: var(--ds-color-text-muted);
      fill-opacity: 0.16;
    }
    .eta,
    .drain {
      stroke: var(--ds-color-text);
      stroke-width: 1.5;
      stroke-dasharray: 5 3;
    }
    .readout {
      position: absolute;
      inset-block-start: 0;
      inset-inline-end: 0;
      max-width: 100%;
      padding: 2px var(--ds-space-2);
      border: 1px solid var(--ds-color-border-strong);
      border-radius: var(--ds-radius);
      background: var(--ds-color-surface-raised);
      color: var(--ds-color-text);
      font-size: var(--ds-font-size);
      pointer-events: none;
    }
    .empty,
    .forecast-note {
      margin: 0;
      color: var(--ds-color-text-muted);
    }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  `,
})
export class LineChart {
  /** The accessible name of the plot. */
  readonly title = input.required<string>();
  readonly series = input.required<readonly ChartSeries[]>();
  /** The visible time range, epoch milliseconds. */
  readonly domain = input.required<{
    readonly from: number;
    readonly to: number;
  }>();
  readonly labels = input.required<ChartLabels>();
  readonly yScale = input<YScaleKind>('zero');
  readonly kind = input<'line' | 'area'>('line');
  /** An `ok` forecast of the anchor series, as the engine sent it; `null` for none. */
  readonly forecast = input<OverlayForecast | null>(null);
  /** The series the forecast starts from; the first visible one when not given. */
  readonly forecastSeries = input<string | null>(null);
  /** The live-region text: newest values and state. The host throttles it. */
  readonly summary = input('');
  /** The width in pixels; measured from the element when not given. */
  readonly width = input<number | null>(null);
  readonly height = input(180);
  readonly locale = input<string | undefined>(undefined);

  protected readonly id = `chart-${String(nextChart++)}`;
  protected readonly margin = MARGIN;
  readonly #measured = signal<number | null>(null);
  readonly #hidden = signal<ReadonlySet<string>>(new Set());
  readonly #cursorT = signal<number | null>(null);
  readonly #hoverT = signal<number | null>(null);

  protected readonly totalWidth = computed(() =>
    Math.max(
      MARGIN.left + MARGIN.right + 80,
      Math.round(this.width() ?? this.#measured() ?? DEFAULT_WIDTH),
    ),
  );
  protected readonly plotWidth = computed(
    () => this.totalWidth() - MARGIN.left - MARGIN.right,
  );
  protected readonly plotHeight = computed(
    () => Math.max(40, this.height()) - MARGIN.top - MARGIN.bottom,
  );

  readonly #visible = computed(() =>
    this.series().filter(
      (s) =>
        s.state === 'drawn' && s.points.length > 0 && !this.#hidden().has(s.id),
    ),
  );
  protected readonly hasData = computed(() => this.#visible().length > 0);
  /** The range the axis shows: with a forecast, room on the right for the overlay. */
  readonly #xDomain = computed(() =>
    this.forecast() === null ? this.domain() : withOverlayRoom(this.domain()),
  );
  readonly #x = computed(() => {
    const { from, to } = this.#xDomain();
    return linearScale(from, to, 0, this.plotWidth());
  });
  readonly #unit = computed(() => this.#visible()[0]?.unit ?? 'count');

  readonly #axis = computed(() => {
    const { from, to } = this.domain();
    let low = Infinity;
    let high = -Infinity;
    for (const series of this.#visible()) {
      for (const point of series.points) {
        if (point.t >= from && point.t <= to && Number.isFinite(point.v)) {
          low = Math.min(low, point.v);
          high = Math.max(high, point.v);
        }
      }
    }
    if (low > high) {
      low = 0;
      high = 1;
    }
    // The forecast ends at zero: keep zero on the axis while it is drawn.
    if (this.forecast() !== null) low = Math.min(low, 0);
    return yAxis(this.yScale(), low, high, this.plotHeight());
  });

  protected readonly yTicks = computed(() => {
    const axis = this.#axis();
    const unit = this.#unit();
    return axis.ticks.map((value) => ({
      y: Math.round(axis.map(value) * 10) / 10,
      label: formatValue(value, unit, this.locale()),
    }));
  });
  protected readonly xTicks = computed(() => {
    const { from, to } = this.#xDomain();
    const x = this.#x();
    return timeTicks(
      from,
      to,
      Math.max(2, Math.floor(this.plotWidth() / 110)),
    ).map((t) => ({
      t,
      x: Math.round(x(t) * 10) / 10,
      label: formatClock(t, this.locale()),
    }));
  });

  protected readonly lines = computed(() => {
    const x = this.#x();
    const axis = this.#axis();
    const { from, to } = this.domain();
    const area = this.kind() === 'area';
    return this.#visible().map((series) => {
      const style = styleOf(series.style);
      const drawn = downsample(series.points, from, to, this.plotWidth());
      const gap = gapThreshold(series.points);
      const last = drawn[drawn.length - 1];
      return {
        id: series.id,
        d: pathOf(drawn, x, axis.map, gap),
        area: area ? areaOf(drawn, x, axis.map, this.plotHeight(), gap) : '',
        colour: `var(${style.colour})`,
        dash: style.dash,
        filled: filled(style.marker),
        marker:
          last === undefined
            ? ''
            : markerPath(style.marker, x(last.t), axis.map(last.v), 3.5),
      };
    });
  });

  protected readonly legend = computed(() =>
    this.series().map((series) => {
      const style = styleOf(series.style);
      return {
        id: series.id,
        label: series.label,
        reported: series.state === 'drawn' && series.points.length > 0,
        reason: series.reason,
        approximate: series.approximate === true,
        hidden: this.#hidden().has(series.id),
        colour: `var(${style.colour})`,
        dash: style.dash,
        filled: filled(style.marker),
        swatch: markerPath(style.marker, 14, 6, 3.5),
      };
    }),
  );

  protected readonly overlay = computed(() => {
    const forecast = this.forecast();
    if (forecast === null) return null;
    const visible = this.#visible();
    const anchor =
      visible.find((s) => s.id === this.forecastSeries()) ?? visible[0];
    const latest = anchor?.points[anchor.points.length - 1];
    if (latest === undefined) return null;
    const dom = this.#xDomain();
    const found = forecastOverlay(forecast, latest, dom);
    if (found === null) return null;
    const x = this.#x();
    const y = this.#axis().map;
    const clamp = (v: number): number =>
      Math.round(Math.min(this.plotHeight(), Math.max(0, v)) * 10) / 10;
    return {
      beyond: found.beyond,
      eta: found.etaT === null ? null : Math.round(x(found.etaT) * 10) / 10,
      band:
        found.band === null
          ? null
          : {
              x: Math.round(x(found.band.fromT) * 10) / 10,
              width: Math.max(
                1,
                Math.round((x(found.band.toT) - x(found.band.fromT)) * 10) / 10,
              ),
            },
      x1: Math.round(x(found.line.from.t) * 10) / 10,
      y1: clamp(y(found.line.from.v)),
      x2: Math.round(x(found.line.to.t) * 10) / 10,
      y2: clamp(y(found.line.to.v)),
    };
  });

  /** The timeline the cursor steps through: the points of the first visible series inside the range. */
  protected readonly cursorPoints = computed(() => {
    const { from, to } = this.domain();
    return (this.#visible()[0]?.points ?? []).filter(
      (p) => p.t >= from && p.t <= to,
    );
  });
  protected readonly cursorIndex = computed(() => {
    const t = this.#cursorT();
    return t === null ? null : nearestIndex(this.cursorPoints(), t);
  });

  #readoutAt(t: number): string {
    const parts = this.#visible().map((series) => {
      const at = series.points[atOrBefore(series.points, t)];
      const value =
        at === undefined
          ? this.labels().noPoint
          : formatValue(at.v, series.unit, this.locale());
      return `${series.label}: ${value}`;
    });
    return `${formatClock(t, this.locale())} · ${parts.join(', ')}`;
  }

  /** The keyboard cursor's readout: the slider's value text. */
  protected readonly keyboardReadout = computed(() => {
    const index = this.cursorIndex();
    const point = index === null ? undefined : this.cursorPoints()[index];
    return point === undefined ? null : this.#readoutAt(point.t);
  });
  /** What the readout box shows: the pointer's position first, else the keyboard cursor's. */
  protected readonly shownReadout = computed(() => {
    const hover = this.#hoverT();
    return hover === null ? this.keyboardReadout() : this.#readoutAt(hover);
  });

  protected readonly cursor = computed(() => {
    const t =
      this.#hoverT() ?? this.cursorPoints()[this.cursorIndex() ?? -1]?.t;
    if (t === undefined) return null;
    const x = this.#x();
    const y = this.#axis().map;
    return {
      x: Math.round(x(t) * 10) / 10,
      dots: this.#visible().flatMap((series) => {
        const at = series.points[atOrBefore(series.points, t)];
        if (at === undefined) return [];
        const style = styleOf(series.style);
        return [
          {
            id: series.id,
            d: markerPath(style.marker, x(at.t), y(at.v), 3.5),
            colour: `var(${style.colour})`,
            filled: filled(style.marker),
          },
        ];
      }),
    };
  });

  readonly #host = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      if (typeof ResizeObserver !== 'function') return;
      const observer = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width ?? 0;
        if (width > 0) this.#measured.set(Math.round(width));
      });
      observer.observe(this.#host.nativeElement);
      destroyRef.onDestroy(() => {
        observer.disconnect();
      });
    });
  }

  protected notReportedText(item: { reason: string | undefined }): string {
    const base = this.labels().notReported;
    return item.reason === undefined || item.reason === ''
      ? base
      : `${base} (${item.reason})`;
  }

  protected toggle(id: string): void {
    this.#hidden.update((hidden) => {
      const next = new Set(hidden);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  protected onKey(event: KeyboardEvent): void {
    const points = this.cursorPoints();
    const next = stepCursor(this.cursorIndex(), event.key, points.length);
    if (next === undefined) return;
    event.preventDefault();
    this.#cursorT.set(next === null ? null : (points[next]?.t ?? null));
  }

  protected onPointer(event: PointerEvent): void {
    const element = event.currentTarget as HTMLElement;
    const rect = element.getBoundingClientRect();
    const scale = rect.width > 0 ? this.totalWidth() / rect.width : 1;
    const px = (event.clientX - rect.left) * scale - MARGIN.left;
    const { from, to } = this.#xDomain();
    const t = from + (px / this.plotWidth()) * (to - from);
    const index = nearestIndex(this.cursorPoints(), t);
    this.#hoverT.set(this.cursorPoints()[index]?.t ?? null);
  }

  protected onLeave(): void {
    this.#hoverT.set(null);
  }
}
