import { createFakeExplorerData } from '@app/explorer-model/testing';
import {
  eventually,
  gridApiOf,
  restoreGridSpecEnvironment,
  warmUpGrid,
  WARM_UP_TIMEOUT_MS,
} from '@app/ui-grid/testing/components';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mountPage } from '../testing/page-testbed';
import { InventoryPage } from './inventory-page.component';

const NAME_CELLS = '.ag-row [col-id="name"]';

/** Waits until the first block is on screen. */
async function firstBlock(el: HTMLElement): Promise<void> {
  await eventually(() => {
    expect(el.querySelectorAll(NAME_CELLS).length).toBeGreaterThan(1);
  }, 8000);
}

describe('<app-inventory-page>', () => {
  beforeAll(warmUpGrid, WARM_UP_TIMEOUT_MS);
  afterAll(restoreGridSpecEnvironment);

  it('AC-15 20,000 queues: scrolling and filtering never request more than a block', async () => {
    const fake = createFakeExplorerData({
      rows: { queues: 20_000 },
      autoSnapshot: true,
    });
    const { el } = await mountPage(InventoryPage, {
      fake,
      inputs: { kind: 'queues' },
    });
    await firstBlock(el);
    const api = gridApiOf(el);

    // The numbers on the page are the engine's: matched of the rows in the index.
    await eventually(() => {
      expect(el.querySelector('.counts')?.textContent.trim()).toBe(
        '20000 of 20000 rows',
      );
    });

    // Scroll to the end in jumps. (That the grid evicts beyond 25 blocks is the grid's own proof, M0-53;
    // here the cap is only checked, because every jump re-renders a DOM that has no virtualisation.)
    const jumps = [4_000, 8_000, 12_000, 16_000, 19_999, 0, 2_000, 6_000];
    for (const index of jumps) {
      const offset = Math.floor(index / 200) * 200;
      api.ensureIndexVisible(index, 'top');
      await eventually(() => {
        expect(fake.queries.some((q) => q.window.offset === offset)).toBe(true);
      });
    }
    // Sort by messages through the header: one sort column, from a fresh scroll.
    el.querySelector<HTMLElement>(
      '.ag-header-cell[col-id="messages"] .ag-header-cell-label',
    )?.click();
    await eventually(() => {
      expect(fake.queries.at(-1)?.sort).toEqual({
        column: 'messages',
        dir: 'asc',
      });
    });
    await eventually(() => {
      expect(el.querySelector('.counts')?.textContent.trim()).toBe(
        '20000 of 20000 rows',
      );
    });

    // Nothing the page sent was larger than a block, off a block boundary or sorted by two columns.
    for (const input of fake.queries) {
      expect(input.window.limit).toBeLessThanOrEqual(200);
      expect(input.window.limit).toBeLessThan(500);
      expect(input.window.offset % 200).toBe(0);
      expect(input.cid).toBe('c1');
      expect(input.kind).toBe('queues');
      if (input.sort) {
        expect(Object.keys(input.sort).sort()).toEqual(['column', 'dir']);
      }
    }
    // At most two requests were ever in flight, and the grid keeps at most 25 blocks.
    expect(fake.maxInflight).toBeLessThanOrEqual(2);
    expect(
      Object.keys(api.getCacheBlockState() as Record<string, unknown>).length,
    ).toBeLessThanOrEqual(25);
  });

  it('shows a name with markup as text, and names every column of the kind', async () => {
    const fake = createFakeExplorerData({ autoSnapshot: true });
    const hostile = "<img src=x onerror='window.__pwned = 1'><b>q</b>";
    fake.bump((rows) => {
      const first = rows.queues[0];
      if (first) rows.queues[0] = { ...first, name: hostile };
    });
    const { el } = await mountPage(InventoryPage, {
      fake,
      inputs: { kind: 'queues' },
    });
    await firstBlock(el);
    const names = [...el.querySelectorAll(NAME_CELLS)].map((c) =>
      c.textContent.trim(),
    );
    expect(names).toContain(hostile);
    expect(el.querySelector('img, b, script')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    const headers = [...el.querySelectorAll('.ag-header-cell-text')].map((h) =>
      h.textContent.trim(),
    );
    expect(headers).toEqual([
      'Name',
      'Virtual host',
      'Type',
      'State',
      'Ready',
      'Unacknowledged',
      'Total',
      'Consumers',
      'Policy',
    ]);
  });

  it('shows no content and makes no call without a connection', async () => {
    const fake = createFakeExplorerData();
    const { el, fixture, connection } = await mountPage(InventoryPage, {
      fake,
      cid: null,
      inputs: { kind: 'queues' },
    });
    await fixture.whenStable();
    expect(el.querySelector('h1')).toBeNull();
    expect(el.querySelector('.ag-root-wrapper')).toBeNull();
    expect(fake.queries).toEqual([]);
    expect(fake.followers).toEqual([]);

    // The connection arrives: the page reads.
    connection.set('c1');
    await firstBlock(el);
    expect(fake.queries.length).toBeGreaterThan(0);
  });

  it('AC-16 the grid page is operable by keyboard with named controls and calm live regions', async () => {
    const fake = createFakeExplorerData({ autoSnapshot: true });
    const { el, fixture } = await mountPage(InventoryPage, {
      fake,
      inputs: { kind: 'queues' },
    });
    await firstBlock(el);

    // The banner is a labelled region with one polite live region; so is the grid's status bar.
    const banner = el.querySelector('section.banner');
    expect(banner?.getAttribute('aria-label')).toBeTruthy();
    const regions = [...el.querySelectorAll('[role="status"]')];
    expect(regions.length).toBeGreaterThanOrEqual(2);
    for (const region of regions) {
      expect(region.getAttribute('aria-live')).toBe('polite');
    }
    // The grid has its own role and an accessible name.
    const grid = el.querySelector('[role="grid"], [role="treegrid"]');
    expect(grid?.getAttribute('aria-label')).toBe('Queues');

    // Every control has a name; the column chooser is a disclosure.
    for (const control of el.querySelectorAll(
      'button, [role="button"], input',
    )) {
      const name =
        control.getAttribute('aria-label') ??
        control.getAttribute('aria-labelledby') ??
        control.textContent.trim();
      expect(name, control.outerHTML.slice(0, 80)).toBeTruthy();
    }
    const toggle = el.querySelector<HTMLButtonElement>('button.toggle');
    expect(toggle?.textContent.trim()).toBe('Columns');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    toggle?.click();
    await fixture.whenStable();
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    const panel = el.querySelector('[role="group"]');
    expect(panel?.getAttribute('aria-label')).toBe('Choose columns');
    // Nothing is colour alone: a notice line starts with a word.
    for (const li of el.querySelectorAll('.banner li')) {
      expect(li.querySelector('.tag')?.textContent.trim()).toBeTruthy();
    }
  });
});
