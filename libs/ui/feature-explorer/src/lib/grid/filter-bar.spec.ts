import { Component, signal } from '@angular/core';
import {
  FILTER_CAPS,
  type ExplorerFilter,
  type ExplorerKind,
} from '@app/explorer-model';
import { createFakeExplorerData } from '@app/explorer-model/testing';
import {
  eventually,
  restoreGridSpecEnvironment,
  warmUpGrid,
  WARM_UP_TIMEOUT_MS,
} from '@app/ui-grid/testing/components';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  addTyped,
  barReady,
  enter,
  openPicker,
  textInput,
  tick,
  type,
} from '../testing/dom';
import { ManualTimer } from '../testing/manual-timer';
import { mountPage } from '../testing/page-testbed';
import { EXPLORER_TIMER } from '../timer';
import { FilterBar } from './filter-bar.component';
import { InventoryPage } from './inventory-page.component';

/** A bar with the filter it edits held outside it, as the page holds it, recording what it emitted. */
@Component({
  imports: [FilterBar],
  template: `<app-filter-bar
    [kind]="kind()"
    [filter]="filter()"
    (filterChange)="applied($event)"
  />`,
})
class BarHost {
  readonly kind = signal<ExplorerKind>('queues');
  readonly filter = signal<ExplorerFilter>({});
  readonly emitted: ExplorerFilter[] = [];
  applied(next: ExplorerFilter): void {
    this.emitted.push(next);
    this.filter.set(next);
  }
}

const labels = (el: HTMLElement): (string | null)[] =>
  [...el.querySelectorAll('.chip-remove')].map((b) =>
    b.getAttribute('aria-label'),
  );

describe('<app-filter-bar>', () => {
  beforeAll(warmUpGrid, WARM_UP_TIMEOUT_MS);
  afterAll(restoreGridSpecEnvironment);

  it('AC-11 filters are text and facets of the contract, applied after a pause, and are never a pattern', async () => {
    // --- the engine side: a pause, Enter, a new source that aborts the old one, a literal pattern.
    const timer = new ManualTimer();
    const fake = createFakeExplorerData({ autoSnapshot: true });
    const held = fake.hold(); // the first blocks are still in flight when the filter applies
    const page = await mountPage(InventoryPage, {
      fake,
      inputs: { kind: 'queues' },
      providers: [{ provide: EXPLORER_TIMER, useValue: timer }],
    });
    await barReady(page.fixture, page.el);
    await eventually(() => {
      expect(fake.queries.length).toBeGreaterThan(0);
    });
    const first = fake.queries.length;
    const field = textInput(page.el);
    type(field, 'ord');
    timer.advance(199);
    expect(fake.queries).toHaveLength(first); // no request for a filter that is not applied
    timer.advance(1);
    await eventually(() => {
      expect(fake.queries.at(-1)?.filter).toEqual({ text: 'ord' });
    });
    // The old source was replaced: what it had in flight is aborted.
    expect(fake.signals.slice(0, first).every((s) => s.aborted)).toBe(true);
    held.release();

    // Typing again restarts the pause; Enter applies at once.
    const before = fake.queries.length;
    type(field, 'orders');
    timer.advance(150);
    type(field, 'orders-1');
    timer.advance(150);
    expect(fake.queries).toHaveLength(before); // the pause started over at the second keystroke
    enter(field);
    await eventually(() => {
      expect(fake.queries.at(-1)?.filter).toEqual({ text: 'orders-1' });
    });
    expect(timer.pending).toBe(0); // Enter cancelled the pause

    // A pattern is text: ".*" is sent as it is and matches nothing, not everything.
    type(field, '.*');
    enter(field);
    await eventually(() => {
      expect(fake.queries.at(-1)?.filter).toEqual({ text: '.*' });
    });
    await eventually(() => {
      expect(page.el.querySelector('.no-match')?.textContent).toContain(
        'No rows match these filters: Name contains ".*"',
      );
    });

    // --- the bar itself: facets, chips, keyboard, caps, and facets that do not apply.
    const bed = await mountPage(BarHost);
    await barReady(bed.fixture, bed.el);
    const host = bed.fixture.componentInstance;
    const search = bed.el.querySelector('form[role="search"]');
    expect(search?.getAttribute('aria-label')).toBe('Filters');

    // Picking a type applies at once; so do typed vhosts, consumers and a minimum.
    tick(await openPicker(bed.fixture, bed.el, 'Queue types'), 'quorum');
    bed.fixture.detectChanges();
    expect(host.emitted.at(-1)).toEqual({ types: ['quorum'] });
    await addTyped(
      bed.fixture,
      await openPicker(bed.fixture, bed.el, 'Virtual hosts'),
      'orders',
    );
    expect(host.emitted.at(-1)).toEqual({
      types: ['quorum'],
      vhosts: ['orders'],
    });
    const select = bed.el.querySelector<HTMLSelectElement>('.consumers select');
    expect(select).not.toBeNull();
    if (select) {
      select.value = 'no';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    bed.fixture.detectChanges(); // the bar sees the new filter before the next edit, as it does for a person
    const min = bed.el.querySelector<HTMLInputElement>('.min input');
    expect(min).not.toBeNull();
    if (min) {
      min.value = '5';
      min.dispatchEvent(new Event('change', { bubbles: true }));
    }
    bed.fixture.detectChanges();
    expect(host.emitted.at(-1)).toEqual({
      types: ['quorum'],
      vhosts: ['orders'],
      hasConsumers: false,
      minMessages: 5,
    });
    await bed.fixture.whenStable();
    expect(labels(bed.el)).toEqual([
      'Remove filter: Virtual host orders',
      'Remove filter: Queue type quorum',
      'Remove filter: Without consumers',
      'Remove filter: At least 5 messages',
    ]);
    expect(bed.el.querySelector('ul.chips')?.getAttribute('aria-label')).toBe(
      'Active filters',
    );

    // Removing a chip moves focus to the chip that took its place.
    const chips = [
      ...bed.el.querySelectorAll<HTMLButtonElement>('.chip-remove'),
    ];
    chips[1]?.focus();
    chips[1]?.click();
    bed.fixture.detectChanges();
    await bed.fixture.whenStable();
    expect(host.emitted.at(-1)?.types).toBeUndefined();
    await eventually(() => {
      expect(document.activeElement?.getAttribute('aria-label')).toBe(
        'Remove filter: Without consumers',
      );
    });
    // Removing the last chips leaves focus in the text field.
    for (let i = 0; i < 4; i++) {
      const remaining =
        bed.el.querySelectorAll<HTMLButtonElement>('.chip-remove');
      if (remaining.length === 0) break;
      remaining[remaining.length - 1]?.click();
      bed.fixture.detectChanges();
      await bed.fixture.whenStable();
    }
    expect(bed.el.querySelector('ul.chips')).toBeNull();
    await eventually(() => {
      expect(document.activeElement).toBe(textInput(bed.el));
    });
    expect(host.emitted.at(-1)).toEqual({});

    // Caps refuse more, with a reason, and change nothing.
    for (let i = 0; i < FILTER_CAPS.types; i++) {
      await addTyped(
        bed.fixture,
        await openPicker(bed.fixture, bed.el, 'Queue types'),
        `t${String(i)}`,
      );
    }
    expect(host.filter().types).toHaveLength(FILTER_CAPS.types);
    await addTyped(
      bed.fixture,
      await openPicker(bed.fixture, bed.el, 'Queue types'),
      'one-too-many',
    );
    expect(host.filter().types).toHaveLength(FILTER_CAPS.types);
    expect(
      (await openPicker(bed.fixture, bed.el, 'Queue types'))
        .querySelector('.reason')
        ?.textContent.trim(),
    ).toBe('At most 16 types can be chosen.');
    for (let i = 0; i < FILTER_CAPS.vhostChips; i++) {
      await addTyped(
        bed.fixture,
        await openPicker(bed.fixture, bed.el, 'Virtual hosts'),
        `v${String(i)}`,
      );
    }
    await addTyped(
      bed.fixture,
      await openPicker(bed.fixture, bed.el, 'Virtual hosts'),
      'v-too-many',
    );
    expect(host.filter().vhosts).toHaveLength(FILTER_CAPS.vhostChips);
    expect(
      (await openPicker(bed.fixture, bed.el, 'Virtual hosts'))
        .querySelector('.reason')
        ?.textContent.trim(),
    ).toBe('At most 25 virtual hosts can be chosen.');
    type(textInput(bed.el), 'x'.repeat(FILTER_CAPS.text + 1));
    await bed.fixture.whenStable();
    expect(textInput(bed.el).value).toHaveLength(FILTER_CAPS.text);
    expect(bed.el.querySelector('form > .reason')?.textContent.trim()).toBe(
      'A filter text is at most 200 characters.',
    );

    // A facet that does not apply to the kind is forced in through the model: neither shown nor emitted.
    const other = await mountPage(BarHost);
    await barReady(other.fixture, other.el);
    const forced = other.fixture.componentInstance;
    forced.kind.set('exchanges');
    forced.filter.set({
      text: 'ex',
      states: ['running'],
      hasConsumers: true,
      minMessages: 5,
    });
    other.fixture.detectChanges();
    await other.fixture.whenStable();
    expect(labels(other.el)).toEqual(['Remove filter: Name contains "ex"']);
    expect(other.el.querySelector('.consumers, .min')).toBeNull();
    type(textInput(other.el), 'exchange');
    enter(textInput(other.el));
    other.fixture.detectChanges();
    expect(forced.emitted.at(-1)).toEqual({ text: 'exchange' });
  });
});
