import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { drawn, LABELS, missing, points } from './chart-spec-support';
import type { ChartSeries } from './chart-types';
import { ChartTable } from './chart-table.component';

@Component({
  imports: [ChartTable],
  template: `<app-chart-table
    [series]="series()"
    [labels]="labels"
    [from]="from()"
    locale="en"
  />`,
})
class Host {
  readonly labels = LABELS;
  readonly series = signal<readonly ChartSeries[]>([]);
  readonly from = signal<number | null>(null);
}

async function mount(series: readonly ChartSeries[]) {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.series.set(series);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const details = el.querySelector<HTMLDetailsElement>('details');
  if (details === null) throw new Error('no details');
  const open = async (): Promise<void> => {
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    fixture.detectChanges();
    await fixture.whenStable();
  };
  return { fixture, host: fixture.componentInstance, el, details, open };
}

describe('<app-chart-table>', () => {
  it('M1-54 AC-14 the table alternative holds the data, bounded, with missing values said', async () => {
    const a = drawn(
      'Ready',
      points(250, (i) => i * 10, 1_000_000, 1000),
    );
    // Unacked reports only every other point; Quorum is not reported at all.
    const b = drawn(
      'Unacked',
      points(125, (i) => i, 1_000_000, 2000),
      1,
    );
    const bed = await mount([a, b, missing('Quorum')]);
    // Closed: a real `<details>` with its summary, and no table built yet.
    expect(bed.el.querySelector('summary')?.textContent.trim()).toBe(
      'Data table',
    );
    expect(bed.el.querySelector('table')).toBeNull();
    await bed.open();

    const table = bed.el.querySelector('table');
    expect(table?.querySelector('caption')?.textContent.trim()).toBe(
      'The values of the chart',
    );
    const heads = [...bed.el.querySelectorAll('thead th')].map((h) =>
      h.textContent.trim(),
    );
    expect(heads).toEqual(['Time', 'Ready', 'Unacked', 'Quorum']);
    expect(bed.el.querySelectorAll('thead th[scope="col"]')).toHaveLength(4);
    // At most 100 rows, newest first, and the rest counted.
    const rows = [...bed.el.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(100);
    expect(bed.el.querySelector('.older')?.textContent.trim()).toBe(
      '150 older rows are not shown',
    );
    const cells = (row: Element | undefined): string[] =>
      [...(row?.querySelectorAll('td') ?? [])].map((c) => c.textContent.trim());
    // The newest time (249 s after the start) has Ready 2.5K and, from the 125th of Unacked, no point.
    expect(cells(rows[0])).toEqual(['2.5K', 'no point', 'not reported']);
    expect(rows[0]?.querySelector('th[scope="row"]')).not.toBeNull();
    // A row where both have a point shows both values.
    expect(cells(rows[1])).toEqual(['2.5K', '124', 'not reported']);
    // Nothing is ever drawn as 0 because it is missing.
    for (const row of rows) {
      expect(cells(row)[2]).toBe('not reported');
    }
    expect(cells(rows[0])[1]).not.toBe('0');

    // Only the range the chart shows: a start time leaves the older rows out.
    bed.host.from.set(1_000_000 + 240_000);
    bed.fixture.detectChanges();
    await bed.fixture.whenStable();
    expect(bed.el.querySelectorAll('tbody tr')).toHaveLength(10);
    expect(bed.el.querySelector('.older')).toBeNull();

    // Closing it takes the table away again.
    bed.details.open = false;
    bed.details.dispatchEvent(new Event('toggle'));
    bed.fixture.detectChanges();
    await bed.fixture.whenStable();
    expect(bed.el.querySelector('table')).toBeNull();
  }, 20_000);
});
