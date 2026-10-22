import { Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import type { CopyOutcome } from './clipboard';
import { LABELS } from './grid-spec-support';
import { fillLabel, GridStatusBar, type GridStatusLabels } from './status-bar';

@Component({
  imports: [GridStatusBar],
  template: `
    <app-grid-status-bar
      [labels]="labels()"
      [total]="total()"
      [loaded]="loaded()"
      [selected]="selected()"
      [loading]="loading()"
      [failed]="failed()"
      [copy]="copy()"
      [capped]="capped()"
      [selectionCap]="5000"
      [dropped]="dropped()"
      (retry)="retries.set(retries() + 1)"
    />
  `,
})
class Host {
  readonly labels = signal<GridStatusLabels>(LABELS.status);
  readonly total = signal<number | null>(null);
  readonly loaded = signal(0);
  readonly selected = signal(0);
  readonly loading = signal(false);
  readonly failed = signal(false);
  readonly copy = signal<CopyOutcome | null>(null);
  readonly capped = signal(false);
  readonly dropped = signal(0);
  readonly retries = signal(0);
}

async function mount() {
  const fixture: ComponentFixture<Host> = TestBed.createComponent(Host);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const text = (selector: string): string | undefined =>
    el.querySelector(selector)?.textContent.trim();
  const live = (): HTMLElement | null =>
    el.querySelector<HTMLElement>('[role="status"]');
  const settle = () => fixture.whenStable();
  return { fixture, host: fixture.componentInstance, el, text, live, settle };
}

describe('<app-grid-status-bar>', () => {
  it('M0-53 AC-13 the status bar tells unknown from zero and announces state', async () => {
    const { host, text, live, settle, el } = await mount();

    // Unknown is said to be unknown; it is never 0.
    expect(text('.total')).toBe('Total not known yet');
    expect(live()?.textContent).not.toContain(' 0 rows');
    // A known total of 0 is 0, and says so.
    host.total.set(0);
    await settle();
    expect(text('.total')).toBe('0 rows');
    // The counts match what the grid holds.
    host.total.set(100000);
    host.loaded.set(1000);
    host.selected.set(3);
    await settle();
    expect(text('.total')).toBe('100000 rows');
    expect(text('.loaded')).toBe('1000 loaded');
    expect(text('.selected')).toBe('3 selected');

    // The state is text in a polite live region.
    const region = live();
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(el.querySelector('.loading')).toBeNull();
    host.loading.set(true);
    await settle();
    expect(region?.querySelector('.loading')?.textContent.trim()).toBe(
      'Loading rows',
    );
    host.loading.set(false);
    host.failed.set(true);
    await settle();
    expect(region?.querySelector('.error')?.textContent.trim()).toBe(
      'Some rows could not be loaded',
    );

    // The retry is a button, outside the live region, and it asks to load again.
    const retry = el.querySelector<HTMLButtonElement>('button.retry');
    expect(retry?.textContent.trim()).toBe('Try again');
    expect(region?.contains(retry)).toBe(false);
    retry?.click();
    expect(host.retries()).toBe(1);
    host.failed.set(false);
    await settle();
    expect(el.querySelector('button.retry')).toBeNull();
    expect(el.querySelector('.error')).toBeNull();
  });

  it('M0-53 AC-13b every word comes from labels', async () => {
    const { host, live, settle } = await mount();
    const words: GridStatusLabels = {
      total: 'T{count}',
      totalUnknown: 'TU',
      loaded: 'L{count}',
      selected: 'S{count}',
      loading: 'LD',
      error: 'ER',
      retry: 'RT',
      copied: 'C{count}',
      copyTruncated: 'CT{count}/{omitted}',
      copyFailed: 'CF',
      selectionCapped: 'SC{count}',
      dropped: 'D{count}',
    };
    host.labels.set(words);
    host.total.set(7);
    host.loaded.set(5);
    host.selected.set(2);
    host.loading.set(true);
    host.failed.set(true);
    host.copy.set({ kind: 'truncated', rows: 4, omitted: 1 });
    host.capped.set(true);
    host.dropped.set(9);
    await settle();
    expect((live()?.textContent ?? '').replace(/\s+/g, ' ').trim()).toBe(
      'T7 L5 S2 LD ER CT4/1 SC5000 D9',
    );
  });

  it('says what a copy did, including what it left out and when it failed', async () => {
    const { host, text, settle } = await mount();
    host.copy.set({ kind: 'copied', rows: 3 });
    await settle();
    expect(text('.copy')).toBe('3 rows copied');
    host.copy.set({ kind: 'truncated', rows: 3, omitted: 2 });
    await settle();
    expect(text('.copy')).toBe('3 rows copied, 2 not copied');
    host.copy.set({ kind: 'failed', reason: new Error('no') });
    await settle();
    expect(text('.copy')).toBe('The clipboard did not accept the copy');
    host.copy.set(null);
    await settle();
    expect(text('.copy')).toBeUndefined();
  });

  it('says when the selection cap stopped an addition and when live changes were dropped', async () => {
    const { host, text, settle } = await mount();
    expect(text('.capped')).toBeUndefined();
    expect(text('.dropped')).toBeUndefined();
    host.capped.set(true);
    host.dropped.set(4);
    await settle();
    expect(text('.capped')).toBe('At most 5000 rows can be selected');
    expect(text('.dropped')).toBe('4 live changes were not applied');
  });

  it('fillLabel puts numbers where the braces are and leaves unknown names alone', () => {
    expect(fillLabel('{count} of {total}', { count: 2, total: 9 })).toBe(
      '2 of 9',
    );
    expect(fillLabel('{count} {other}', { count: 1 })).toBe('1 {other}');
  });
});
