import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { entityUrl } from '@app/explorer-model';
import { createFakeExplorerData } from '@app/explorer-model/testing';
import { EngineProblemError } from '@app/ui-data';
import { GRID_CLIPBOARD } from '@app/ui-grid';
import { FakeEngine } from '@app/ui-platform/testing';
import {
  eventually,
  gridApiOf,
  restoreGridSpecEnvironment,
  warmUpGrid,
  WARM_UP_TIMEOUT_MS,
} from '@app/ui-grid/testing/components';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  barReady,
  enter,
  openPicker,
  textInput,
  tick,
  type,
  PAGE_TEST_TIMEOUT_MS,
} from '../testing/dom';
import { FakeWorkspace } from '../testing/fake-workspace';
import { ManualTimer } from '../testing/manual-timer';
import { mountPage, pageProviders } from '../testing/page-testbed';
import { EXPLORER_NAVIGATION, type EntityTarget } from '../navigation';
import { EXPLORER_TIMER } from '../timer';
import { InventoryPage } from './inventory-page.component';
import { InventoryRoute } from './inventory-route.component';

const NAME_CELLS = '.ag-row [col-id="name"]';

/** Waits until the first block is on screen. */
async function firstBlock(el: HTMLElement): Promise<void> {
  await eventually(() => {
    expect(el.querySelectorAll(NAME_CELLS).length).toBeGreaterThan(1);
  }, 8000);
}

const counts = (el: HTMLElement): string | undefined =>
  el.querySelector('.counts')?.textContent.trim();

describe('<app-inventory-page>', () => {
  beforeAll(warmUpGrid, WARM_UP_TIMEOUT_MS);
  afterAll(restoreGridSpecEnvironment);

  it(
    'M0-54 AC-15 20,000 queues: scrolling and filtering never request more than a block',
    async () => {
      const fake = createFakeExplorerData({
        rows: { queues: 20_000 },
        autoSnapshot: true,
      });
      const timer = new ManualTimer();
      const { el, fixture } = await mountPage(InventoryPage, {
        fake,
        inputs: { kind: 'queues' },
        providers: [{ provide: EXPLORER_TIMER, useValue: timer }],
      });
      await firstBlock(el);
      const api = gridApiOf(el);

      // The numbers on the page are the engine's: matched of the rows in the index.
      await eventually(() => {
        expect(counts(el)).toBe('20000 of 20000 rows');
      });

      // Scroll to the end in jumps. (That the grid evicts beyond 25 blocks is the grid's own proof, M0-53;
      // here the cap is only checked, because every jump re-renders a DOM that has no virtualisation.)
      const jumps = [4_000, 12_000, 19_999, 0, 6_000];
      for (const index of jumps) {
        const offset = Math.floor(index / 200) * 200;
        api.ensureIndexVisible(index, 'top');
        await eventually(() => {
          expect(fake.queries.some((q) => q.window.offset === offset)).toBe(
            true,
          );
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

      // A filter typed is not sent until it applies; then the counts are the engine's, not 20,000.
      const sent = fake.queries.length;
      type(textInput(el), 'queue-0001');
      timer.advance(199);
      expect(fake.queries).toHaveLength(sent);
      timer.advance(1);
      await eventually(() => {
        expect(fake.queries.at(-1)?.filter).toEqual({ text: 'queue-0001' });
        expect(counts(el)).toBe('10 of 20000 rows');
      });
      // A facet applies at once.
      tick(await openPicker(fixture, el, 'Queue types'), 'quorum');
      await eventually(() => {
        expect(fake.queries.at(-1)?.filter).toEqual({
          text: 'queue-0001',
          types: ['quorum'],
        });
        expect(counts(el)).toBe('4 of 20000 rows'); // queue-000010 to 19: every third is a quorum queue
      });
      // Clearing the filter reads the whole list again.
      for (let removed = 0; removed < 2; removed++) {
        el.querySelector<HTMLButtonElement>('.chip-remove')?.click();
        fixture.detectChanges();
        await fixture.whenStable();
      }
      await eventually(() => {
        expect(fake.queries.at(-1)?.filter).toBeUndefined();
        expect(counts(el)).toBe('20000 of 20000 rows');
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
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'M0-54 AC-14 a bindings page asks for exactly one vhost before it reads',
    async () => {
      const fake = createFakeExplorerData({ autoSnapshot: true });
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          ...pageProviders(
            fake,
            signal<string | null>('c1'),
            new FakeEngine({ handler: new FakeWorkspace().handler }),
          ),
          provideRouter([
            {
              path: 'bindings',
              component: InventoryRoute,
              data: { kind: 'bindings' },
            },
          ]),
        ],
      });
      const harness = await RouterTestingHarness.create();
      await harness.navigateByUrl('/bindings');
      const el = harness.routeNativeElement;
      if (el === null) throw new Error('nothing is routed');
      await eventually(() => {
        harness.detectChanges();
        expect(el.querySelector('.notice')?.textContent).toContain(
          'Choose one virtual host to list its bindings.',
        );
      });
      // No vhost: nothing is read, nothing is followed.
      expect(fake.queries).toEqual([]);
      expect(fake.followers).toEqual([]);

      // Choosing one puts it in the address and in the filter; the rows are the bindings of that vhost.
      const field = el.querySelector<HTMLInputElement>('.vhost-input');
      if (!field) throw new Error('no vhost field');
      field.value = 'orders';
      enter(field);
      await eventually(() => {
        harness.detectChanges();
        expect(TestBed.inject(Router).url).toBe('/bindings?vhost=orders');
        expect(fake.queries.at(-1)?.filter).toEqual({ vhosts: ['orders'] });
      });
      await eventually(() => {
        expect(
          el.querySelectorAll('.ag-row [col-id="source"]').length,
        ).toBeGreaterThan(1);
      }, 8000);
      // The topic has no bindings: the page says so and follows nothing.
      expect(el.textContent).toContain('Bindings are not followed live.');
      expect(fake.followers).toEqual([]);
      // Every query names that one vhost and no other.
      for (const input of fake.queries) {
        expect(input.kind).toBe('bindings');
        expect(input.filter?.vhosts).toEqual(['orders']);
      }

      // A vhost the connection does not have: the engine's Problem is shown as it was sent.
      fake.failNext(
        new EngineProblemError({
          type: 'about:blank',
          title: 'Virtual host not found',
          status: 404,
          code: 'NOT_FOUND',
          detail: 'The connection has no virtual host named nope.',
          correlationId: 'c',
          retryable: false,
        }),
      );
      field.value = 'nope';
      enter(field);
      await eventually(() => {
        harness.detectChanges();
        const text = el.textContent;
        expect(text).toContain('The inventory could not be read.');
        expect(text).toContain('Virtual host not found');
        expect(text).toContain(
          'The connection has no virtual host named nope.',
        );
      }, 8000);
      expect(TestBed.inject(Router).url).toBe('/bindings?vhost=nope');
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-8 a grid row opens its entity and the menu offers open and copy link',
    async () => {
      const fake = createFakeExplorerData({
        rows: { queues: 20, bindings: 5 },
        autoSnapshot: true,
      });
      const opened: { cid: string; target: EntityTarget; label: string }[] = [];
      const written: string[] = [];
      const providers = [
        {
          provide: EXPLORER_NAVIGATION,
          useValue: {
            href: (cid: string, target: EntityTarget) =>
              entityUrl(cid, target, target.tab),
            open: (cid: string, target: EntityTarget, label: string) =>
              void opened.push({ cid, target, label }),
          },
        },
        {
          provide: GRID_CLIPBOARD,
          useValue: {
            writeText: (text: string) => {
              written.push(text);
              return Promise.resolve();
            },
          },
        },
      ];
      const { el, fixture, engine } = await mountPage(InventoryPage, {
        fake,
        inputs: { kind: 'queues' },
        providers,
      });
      await firstBlock(el);
      await eventually(() => {
        expect(el.querySelector('.loaded')?.textContent.trim()).toMatch(
          /^[1-9]/,
        );
      });
      const first = fake.rows().queues[0];
      const second = fake.rows().queues[1];
      if (first === undefined || second === undefined) throw new Error('rows');
      const cells = (): HTMLElement[] => [
        ...el.querySelectorAll<HTMLElement>(NAME_CELLS),
      ];

      // Enter on a row opens its entity, with the queue's name as the label of the tab.
      cells()[0]?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      );
      await eventually(() => {
        expect(opened).toEqual([
          {
            cid: 'c1',
            target: { kind: 'queues', key: first.key },
            label: first.name,
          },
        ]);
      });
      // A double click opens the row it is on.
      cells()[1]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await eventually(() => {
        expect(opened.map((o) => o.target.key)).toEqual([
          first.key,
          second.key,
        ]);
      });

      // The menu has exactly two entries.
      cells()[0]?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        }),
      );
      await eventually(() => {
        fixture.detectChanges();
        expect(
          [...el.querySelectorAll('[role="menuitem"]')].map((i) =>
            i.textContent.trim(),
          ),
        ).toEqual(['Open details', 'Copy link']);
      });
      const items = (): HTMLElement[] => [
        ...el.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ];
      items()[1]?.click();
      await eventually(() => {
        fixture.detectChanges();
        expect(written).toEqual([
          `${window.location.origin}/c/c1/queues/${first.key}`,
        ]);
        expect(el.textContent).toContain('Link copied.');
      });
      // Open details from the menu opens the same entity again.
      cells()[0]?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
      await eventually(() => {
        fixture.detectChanges();
        expect(items()).toHaveLength(2);
      });
      items()[0]?.click();
      await eventually(() => {
        expect(opened).toHaveLength(3);
        expect(opened[2]?.target.key).toBe(first.key);
      });

      // Only reads were made: the inventory and the topic through the fake, the profile and the views list.
      expect(fake.queries.every((q) => q.kind === 'queues')).toBe(true);
      for (const request of engine.requests) {
        expect(new URL(request.url, 'http://engine.test').pathname).toMatch(
          /\/(profile|views)$/,
        );
        expect(request.method).toBe('GET');
      }

      // The bindings grid opens a binding, named by its two ends.
      opened.length = 0;
      const bindings = await mountPage(InventoryPage, {
        fake,
        inputs: { kind: 'bindings', vhost: '/' },
        providers,
      });
      await eventually(() => {
        expect(
          bindings.el.querySelectorAll('.ag-row [col-id="source"]').length,
        ).toBeGreaterThan(1);
      }, 8000);
      await eventually(() => {
        expect(
          bindings.el.querySelector('.loaded')?.textContent.trim(),
        ).toMatch(/^[1-9]/);
      });
      const row = fake.rows().bindings.find((b) => b.vhost === '/');
      bindings.el
        .querySelector<HTMLElement>('.ag-row [col-id="source"]')
        ?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
          }),
        );
      await eventually(() => {
        expect(opened).toHaveLength(1);
      });
      expect(opened[0]?.target.kind).toBe('bindings');
      expect(opened[0]?.label).toMatch(/^\S+ -> \S+$/);
      expect(row).toBeDefined();
    },
    PAGE_TEST_TIMEOUT_MS,
  );
  it(
    'M0-54 AC-29 a broker with no queues says so in words, and a list that is still loading never says it',
    async () => {
      // The whole list was read and it is empty: a sentence, not a blank grid.
      const empty = createFakeExplorerData({
        rows: { queues: 0 },
        autoSnapshot: true,
      });
      const done = await mountPage(InventoryPage, {
        fake: empty,
        inputs: { kind: 'queues' },
      });
      await eventually(() => {
        done.fixture.detectChanges();
        expect(done.el.querySelector('.empty')?.textContent.trim()).toBe(
          'This broker has no queues.',
        );
      }, 8000);
      expect(counts(done.el)).toBe('0 of 0 rows');

      // The first sweep has not delivered yet: the engine says "loading" and the page does not claim emptiness.
      const starting = createFakeExplorerData({
        rows: { queues: 0 },
        autoSnapshot: true,
      });
      starting.setFreshness({ state: 'loading', complete: false });
      const loading = await mountPage(InventoryPage, {
        fake: starting,
        inputs: { kind: 'queues' },
      });
      await eventually(() => {
        loading.fixture.detectChanges();
        expect(loading.el.textContent).toContain('Loading the inventory');
      }, 8000);
      expect(loading.el.querySelector('.empty')).toBeNull();
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'shows a name with markup as text, and names every column of the kind',
    async () => {
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
      expect(
        (window as unknown as { __pwned?: number }).__pwned,
      ).toBeUndefined();
      const headers = [...el.querySelectorAll('.ag-header-cell-text')].map(
        (h) => h.textContent.trim(),
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
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'shows no content and makes no call without a connection',
    async () => {
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
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'M0-54 AC-16 the grid page is operable by keyboard with named controls and calm live regions',
    async () => {
      const fake = createFakeExplorerData({ autoSnapshot: true });
      const { el, fixture } = await mountPage(InventoryPage, {
        fake,
        inputs: { kind: 'queues' },
      });
      await firstBlock(el);
      await barReady(fixture, el);

      // The filter bar is a labelled search; the banner is a labelled region with one polite live region
      // (and so is the grid's status bar).
      expect(
        el.querySelector('form[role="search"]')?.getAttribute('aria-label'),
      ).toBe('Filters');
      expect(
        el.querySelector('section.banner')?.getAttribute('aria-label'),
      ).toBeTruthy();
      const regions = [...el.querySelectorAll('[role="status"]')];
      expect(regions.length).toBeGreaterThanOrEqual(2);
      for (const region of regions) {
        expect(region.getAttribute('aria-live')).toBe('polite');
      }
      // The grid has its own role and an accessible name.
      const grid = el.querySelector('[role="grid"], [role="treegrid"]');
      expect(grid?.getAttribute('aria-label')).toBe('Queues');

      // Facet pickers and the column chooser are disclosures; chips are a list with named remove buttons.
      const types = [...el.querySelectorAll<HTMLButtonElement>('.toggle')].find(
        (b) => b.textContent.trim() === 'Queue types',
      );
      expect(types?.getAttribute('aria-expanded')).toBe('false');
      const panel = await openPicker(fixture, el, 'Queue types');
      expect(types?.getAttribute('aria-expanded')).toBe('true');
      expect(panel.getAttribute('aria-label')).toBe('Queue types');
      tick(panel, 'quorum');
      await eventually(() => {
        expect(el.querySelector('ul.chips')?.getAttribute('aria-label')).toBe(
          'Active filters',
        );
      });
      const columns = el.querySelector<HTMLButtonElement>('button.toggle');
      expect(columns).not.toBeNull();
      const chooser = [
        ...el.querySelectorAll<HTMLButtonElement>('.toggle'),
      ].find((b) => b.textContent.trim() === 'Columns');
      expect(chooser?.getAttribute('aria-expanded')).toBe('false');
      chooser?.click();
      await fixture.whenStable();
      expect(chooser?.getAttribute('aria-expanded')).toBe('true');
      expect(
        [...el.querySelectorAll('[role="group"]')].some(
          (g) => g.getAttribute('aria-label') === 'Choose columns',
        ),
      ).toBe(true);

      // Every control has a name.
      for (const control of el.querySelectorAll(
        'button, [role="button"], input, select',
      )) {
        const labelled =
          control instanceof HTMLInputElement ||
          control instanceof HTMLSelectElement
            ? [...(control.labels ?? [])]
                .map((l) => l.textContent.trim())
                .join(' ')
            : '';
        const name =
          control.getAttribute('aria-label') ??
          control.getAttribute('aria-labelledby') ??
          (labelled || control.textContent.trim());
        expect(name, control.outerHTML.slice(0, 80)).toBeTruthy();
      }
      // Nothing is colour alone: a notice line starts with a word.
      for (const li of el.querySelectorAll('.banner li')) {
        expect(li.querySelector('.tag')?.textContent.trim()).toBeTruthy();
      }
      // Escape closes a picker and returns focus to its button.
      panel.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await fixture.whenStable();
      expect(types?.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(types);
    },
    PAGE_TEST_TIMEOUT_MS,
  );
});
