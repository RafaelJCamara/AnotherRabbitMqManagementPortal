import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { drawn, LABELS, missing, points, vertices } from './chart-spec-support';
import type { ChartSeries } from './chart-types';
import type { OverlayForecast } from './draw/overlay';
import type { YScaleKind } from './draw/scales';
import { LineChart } from './line-chart.component';

@Component({
  imports: [LineChart],
  template: `
    <app-line-chart
      [title]="name"
      [series]="series()"
      [domain]="domain()"
      [labels]="labels"
      [yScale]="yScale()"
      [forecast]="forecast()"
      [summary]="summary()"
      [width]="300"
      locale="en"
    />
  `,
})
class Host {
  readonly name = 'Backlog';
  readonly labels = LABELS;
  readonly series = signal<readonly ChartSeries[]>([]);
  readonly domain = signal({ from: 0, to: 100_000 });
  readonly yScale = signal<YScaleKind>('zero');
  readonly forecast = signal<OverlayForecast | null>(null);
  readonly summary = signal('Ready 5');
}

async function mount(series: readonly ChartSeries[]) {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.series.set(series);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const settle = async (): Promise<void> => {
    fixture.detectChanges();
    await fixture.whenStable();
  };
  const paths = (): string[] =>
    [...el.querySelectorAll('.line')].map((p) => p.getAttribute('d') ?? '');
  const plot = (): HTMLElement => {
    const found = el.querySelector<HTMLElement>('.plot');
    if (found === null) throw new Error('no plot');
    return found;
  };
  const key = async (name: string): Promise<void> => {
    plot().dispatchEvent(
      new KeyboardEvent('keydown', {
        key: name,
        bubbles: true,
        cancelable: true,
      }),
    );
    await settle();
  };
  return {
    fixture,
    host: fixture.componentInstance,
    el,
    settle,
    paths,
    plot,
    key,
  };
}

const ready = drawn(
  'Ready',
  points(101, (i) => 100 + i, 0, 1000),
  0,
);
const unacked = drawn(
  'Unacked',
  points(101, (i) => (i % 10) * 3, 0, 1000),
  1,
);

describe('<app-line-chart>', () => {
  it('M1-54 AC-12 the line chart draws bounded paths, breaks at gaps and lists what is not reported', async () => {
    // 5,000 points at width 300 (a plot of 232 pixels): at most four vertices per pixel column.
    const dense = drawn(
      'Dense',
      points(5000, (i) => (i % 97) * 3, 0, 20),
    );
    const gap = drawn('Gap', [
      ...points(10, (i) => i, 0, 1000),
      ...points(10, (i) => i, 60_000, 1000),
    ]);
    const bed = await mount([
      dense,
      gap,
      missing('Quorum', 'statistics are off'),
    ]);
    bed.host.domain.set({ from: 0, to: 100_000 });
    await bed.settle();
    const [denseD, gapD] = bed.paths();
    expect(vertices(denseD ?? '')).toBeLessThanOrEqual(4 * 232);
    expect(vertices(denseD ?? '')).toBeGreaterThan(50);
    // A silence is a gap in the line, not a bridge: two runs.
    expect(gapD?.match(/M/g)).toHaveLength(2);
    // The series the engine does not report is in the legend with its reason, and has no line.
    expect(bed.paths()).toHaveLength(2);
    const off = bed.el.querySelector('.legend-item.off');
    expect(off?.textContent).toContain('Quorum');
    expect(off?.textContent).toContain('not reported (statistics are off)');
    expect(off?.querySelector('button')).toBeNull();
    expect(bed.el.querySelectorAll('button.legend-item')).toHaveLength(2);
    // A path never carries a non-finite number.
    for (const d of bed.paths()) expect(d).not.toMatch(/NaN|Infinity/);

    // The legend toggles a series: pressed state, no path, and the axis fits what is left.
    const button =
      bed.el.querySelector<HTMLButtonElement>('button.legend-item');
    expect(button?.getAttribute('aria-pressed')).toBe('true');
    button?.click();
    await bed.settle();
    expect(button?.getAttribute('aria-pressed')).toBe('false');
    expect(bed.paths()).toHaveLength(1);
    button?.click();
    await bed.settle();
    expect(bed.paths()).toHaveLength(2);

    // With every series hidden or not reported there is nothing to draw and the chart says so.
    for (const toggle of bed.el.querySelectorAll<HTMLButtonElement>(
      'button.legend-item',
    )) {
      toggle.click();
    }
    await bed.settle();
    expect(bed.el.querySelector('svg.svg')).toBeNull();
    expect(bed.el.querySelector('.empty')?.textContent).toContain(
      'There is nothing to draw.',
    );
    // A series that was never reported draws nothing at all, never a line at zero.
    const none = await mount([missing('A'), missing('B')]);
    expect(none.paths()).toEqual([]);
    expect(none.el.querySelector('.empty')).not.toBeNull();
  }, 20_000);

  it('M1-54 AC-12 the y-scale choice changes the axis, and a flat series has a visible axis', async () => {
    const bed = await mount([
      drawn(
        'Ready',
        points(20, () => 500, 0, 1000),
      ),
    ]);
    await bed.settle();
    const labels = (): string[] =>
      [...bed.el.querySelectorAll('.tick')].map((t) => t.textContent.trim());
    const zero = labels();
    expect(zero).toContain('0');
    bed.host.yScale.set('fit');
    await bed.settle();
    // Fitted to a flat 500, the axis does not start at zero and is not collapsed to a single label.
    expect(labels()).not.toEqual(zero);
    expect(
      new Set(labels().filter((l) => /\d/.test(l) && !l.includes(':'))).size,
    ).toBeGreaterThan(1);
    bed.host.yScale.set('log');
    await bed.settle();
    expect(labels()).toContain('1K');
  }, 20_000);

  it('M1-54 AC-13 the cursor is keyboard-operable and the readout is announced on keys only', async () => {
    const bed = await mount([ready, unacked]);
    await bed.settle();
    const plot = bed.plot();
    expect(plot.getAttribute('role')).toBe('slider');
    expect(plot.getAttribute('tabindex')).toBe('0');
    expect(plot.getAttribute('aria-label')).toBe('Backlog');
    expect(plot.getAttribute('aria-orientation')).toBe('horizontal');
    const hint = bed.el.querySelector(
      `#${plot.getAttribute('aria-describedby') ?? 'x'}`,
    );
    expect(hint?.textContent).toContain('arrow keys');
    // Before any key the value text is the summary, and the cursor sits on the newest point.
    expect(plot.getAttribute('aria-valuetext')).toBe('Ready 5');
    expect(plot.getAttribute('aria-valuemin')).toBe('0');
    expect(plot.getAttribute('aria-valuemax')).toBe('100');
    expect(plot.getAttribute('aria-valuenow')).toBe('100');

    await bed.key('ArrowLeft');
    expect(plot.getAttribute('aria-valuenow')).toBe('100'); // from no cursor: the newest point
    expect(plot.getAttribute('aria-valuetext')).toMatch(
      /^\d{2}:\d{2}:\d{2}\s?(?:[AP]M)? · Ready: 200, Unacked: 0$/,
    );
    await bed.key('ArrowLeft');
    expect(plot.getAttribute('aria-valuenow')).toBe('99');
    expect(plot.getAttribute('aria-valuetext')).toContain('Ready: 199');
    await bed.key('PageUp');
    expect(plot.getAttribute('aria-valuenow')).toBe('89');
    await bed.key('Home');
    expect(plot.getAttribute('aria-valuenow')).toBe('0');
    expect(plot.getAttribute('aria-valuetext')).toContain('Ready: 100');
    await bed.key('ArrowLeft'); // stops at the first point
    expect(plot.getAttribute('aria-valuenow')).toBe('0');
    await bed.key('End');
    expect(plot.getAttribute('aria-valuenow')).toBe('100');
    expect(bed.el.querySelector('line.cursor')).not.toBeNull();
    // A key the chart does not use is left alone (not prevented), and Escape clears the cursor.
    const other = new KeyboardEvent('keydown', { key: 'a', cancelable: true });
    plot.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
    await bed.key('Escape');
    expect(plot.getAttribute('aria-valuetext')).toBe('Ready 5');
    expect(bed.el.querySelector('line.cursor')).toBeNull();

    // A pointer shows the readout and moves the crosshair but changes nothing that is announced.
    const before = plot.getAttribute('aria-valuetext');
    const nowBefore = plot.getAttribute('aria-valuenow');
    plot.dispatchEvent(
      new MouseEvent('pointermove', { clientX: 100, bubbles: true }),
    );
    await bed.settle();
    expect(bed.el.querySelector('.readout')?.textContent).toMatch(/Ready: \d+/);
    expect(bed.el.querySelector('line.cursor')).not.toBeNull();
    expect(plot.getAttribute('aria-valuetext')).toBe(before);
    expect(plot.getAttribute('aria-valuenow')).toBe(nowBefore);
    plot.dispatchEvent(new MouseEvent('pointerleave', { bubbles: true }));
    await bed.settle();
    expect(bed.el.querySelector('.readout')).toBeNull();
    // The summary has its own polite live region.
    const live = bed.el.querySelector('[aria-live="polite"]');
    expect(live?.textContent.trim()).toBe('Ready 5');
    bed.host.summary.set('Ready 6');
    await bed.settle();
    expect(live?.textContent.trim()).toBe('Ready 6');
  }, 20_000);

  it('M1-54 AC-15 the forecast overlay is drawn for a usable forecast only, and an ETA beyond the chart is said', async () => {
    const bed = await mount([
      drawn(
        'Ready',
        points(101, (i) => 1000 - i * 5, 0, 1000),
      ),
    ]);
    const overlay = (): {
      drain: boolean;
      band: boolean;
      eta: boolean;
      note: string;
    } => ({
      drain: bed.el.querySelector('line.drain') !== null,
      band: bed.el.querySelector('rect.band') !== null,
      eta: bed.el.querySelector('line.eta') !== null,
      note:
        bed.el
          .querySelector('.forecast-note')
          ?.textContent.replace(/\s+/g, ' ')
          .trim() ?? '',
    });
    expect(overlay()).toEqual({
      drain: false,
      band: false,
      eta: false,
      note: '',
    });

    // The newest point is at t = 100 s; the ETA 20 s later is inside the room the chart keeps on the right.
    bed.host.forecast.set({ etaMs: 20_000, lowMs: 15_000, highMs: 25_000 });
    await bed.settle();
    expect(overlay()).toEqual({
      drain: true,
      band: true,
      eta: true,
      note: 'Forecast drawn.',
    });
    // No upper bound: the band goes on to the right edge.
    bed.host.forecast.set({ etaMs: 20_000, lowMs: 15_000, highMs: null });
    await bed.settle();
    expect(overlay().band).toBe(true);
    // An ETA far beyond the chart: the drain line stops at the edge and the page says so in words.
    bed.host.forecast.set({
      etaMs: 3_600_000,
      lowMs: 3_000_000,
      highMs: 4_000_000,
    });
    await bed.settle();
    expect(overlay()).toMatchObject({ drain: true, eta: false, band: false });
    expect(overlay().note).toBe(
      'Forecast drawn. The forecast is beyond the chart.',
    );
    // A forecast that cannot be used draws nothing (the host passes only an `ok`, and the chart checks again).
    bed.host.forecast.set({ etaMs: 100, lowMs: 200, highMs: 300 });
    await bed.settle();
    expect(overlay()).toEqual({
      drain: false,
      band: false,
      eta: false,
      note: '',
    });
  }, 20_000);
});
