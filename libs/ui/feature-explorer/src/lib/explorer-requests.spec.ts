// M0-54 AC-28: the explorer reads the inventory, the overview and the profile, keeps the person's own saved views,
// and follows `explorer.window`; it makes no other call. The pages run through the real engine-backed data port
// (`createEngineExplorerData`) and the real `EngineApi` and live client over the fake engine, which records every
// request and every client frame, and the spec checks the whole record against an allow-list. Nothing here reaches
// a real engine: the answers come from the model's fake and the fake workspace.
import { createFakeExplorerData } from '@app/explorer-model/testing';
import {
  eventually,
  restoreGridSpecEnvironment,
  warmUpGrid,
  WARM_UP_TIMEOUT_MS,
} from '@app/ui-grid/testing/components';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { InventoryPage } from './grid/inventory-page.component';
import { OverviewPage } from './overview/overview.component';
import {
  barReady,
  enter,
  textInput,
  type,
  PAGE_TEST_TIMEOUT_MS,
} from './testing/dom';
import { FakeWorkspace } from './testing/fake-workspace';
import { ManualTimer } from './testing/manual-timer';
import { mountPage, type PageBed } from './testing/page-testbed';
import { EXPLORER_TIMER } from './timer';

/** Method and path of every REST request the explorer may make; the ticket for the live socket is the transport's. */
const ALLOWED: readonly RegExp[] = [
  /^POST \/api\/v1\/connections\/[^/]+\/inventory\/queries$/, // inventory.query
  /^GET \/api\/v1\/connections\/[^/]+\/overview$/, // overview.get
  /^GET \/api\/v1\/connections\/[^/]+\/profile$/, // profile.get
  /^GET \/api\/v1\/views(\?[^/]*)?$/, // views.list
  /^POST \/api\/v1\/views$/, // views.create
  /^DELETE \/api\/v1\/views\/[^/]+$/, // views.delete
  /^POST \/api\/v1\/live\/tickets$/, // the live socket's single-use ticket
];

const line = (request: { method: string; url: string }): string =>
  `${request.method} ${request.url}`;

const OVERVIEW = {
  product: 'RabbitMQ',
  version: '4.3.6',
  totals: { queues: 12 },
  rates: { state: 'unavailable', reason: 'not-reported' },
  nodes: [{ name: 'rabbit@a', running: true }],
  alarms: { state: 'none' },
  freshness: {
    state: 'live',
    complete: true,
    loaded: 12,
    truncated: false,
    dropped: 0,
    hazards: [],
    versionChanged: false,
  },
};

const button = (el: HTMLElement, selector: string): HTMLButtonElement => {
  const found = el.querySelector<HTMLButtonElement>(selector);
  if (!found) throw new Error(`no ${selector}`);
  return found;
};

describe('the requests of the explorer', () => {
  beforeAll(warmUpGrid, WARM_UP_TIMEOUT_MS);
  afterAll(restoreGridSpecEnvironment);

  it(
    'AC-28 the explorer calls only its read actions and the two view commands',
    async () => {
      // A direct `fetch` would bypass the engine API altogether.
      const direct = vi.fn<typeof fetch>(() =>
        Promise.reject(new Error('the explorer must not call fetch')),
      );
      vi.stubGlobal('fetch', direct);
      const beds: PageBed<unknown>[] = [];
      try {
        // The grid page: rows, a filter, a sort, the views control (apply, save, delete) and the live follow.
        const workspace = new FakeWorkspace();
        workspace.overview = () => OVERVIEW;
        workspace.add({
          name: 'Mine',
          kind: 'queues',
          definition: {
            version: 1,
            kind: 'queues',
            filter: { text: 'orders' },
          },
        });
        const fake = createFakeExplorerData({
          rows: { queues: 30 },
          autoSnapshot: true,
        });
        const page = await mountPage(InventoryPage, {
          fake,
          workspace,
          engineBacked: true,
          inputs: { kind: 'queues' },
        });
        beds.push(page);
        await eventually(() => {
          page.fixture.detectChanges();
          expect(
            page.el.querySelectorAll('.ag-row [col-id="name"]').length,
          ).toBeGreaterThan(1);
        }, 8000);
        // The grid tells the source which rows are on screen after 100 ms, and the page follows them.
        await eventually(() => {
          expect(
            page.engine.clientFrames.some((frame) => frame.t === 'sub'),
          ).toBe(true);
        }, 8000);
        await barReady(page.fixture, page.el);
        type(textInput(page.el), 'queue-00');
        enter(textInput(page.el));
        await eventually(() => {
          expect(fake.queries.at(-1)?.filter).toEqual({ text: 'queue-00' });
        });
        page.el
          .querySelector<HTMLElement>(
            '.ag-header-cell[col-id="messages"] .ag-header-cell-label',
          )
          ?.click();
        await eventually(() => {
          expect(fake.queries.at(-1)?.sort).toEqual({
            column: 'messages',
            dir: 'asc',
          });
        });
        const openViews = async (): Promise<void> => {
          await eventually(() => {
            page.fixture.detectChanges();
            expect(page.el.querySelector('.views-toggle')).not.toBeNull();
          });
          const toggle = button(page.el, '.views-toggle');
          if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
          await eventually(() => {
            page.fixture.detectChanges();
            expect(page.el.querySelector('.name-input')).not.toBeNull();
          });
        };
        await openViews();
        await eventually(() => {
          page.fixture.detectChanges();
          expect(
            page.el
              .querySelector('.save app-gated button.control')
              ?.getAttribute('aria-disabled'),
          ).toBeNull(); // the gate opened once the profile was read
        });
        const field = page.el.querySelector<HTMLInputElement>('.name-input');
        if (field) field.value = 'Saved';
        button(page.el, '.save app-gated button.control').click();
        await eventually(() => {
          expect(workspace.views.map((v) => v.name)).toContain('Saved');
        });
        await openViews();
        button(page.el, '.delete-ask').click();
        await eventually(() => {
          page.fixture.detectChanges();
          expect(page.el.querySelector('.confirm')).not.toBeNull();
        });
        button(page.el, '.confirm app-gated button.control').click();
        await eventually(() => {
          expect(
            workspace.requestLines.some((l) => l.startsWith('DELETE')),
          ).toBe(true);
        });

        // The overview: one read on open and one on a spaced refresh.
        const timer = new ManualTimer();
        const overview = await mountPage(OverviewPage, {
          workspace,
          engineBacked: true,
          providers: [{ provide: EXPLORER_TIMER, useValue: timer }],
        });
        beds.push(overview);
        await eventually(() => {
          overview.fixture.detectChanges();
          expect(overview.el.querySelector('.region')).not.toBeNull();
        });
        timer.advance(10_000);
        overview.fixture.detectChanges();
        button(overview.el, '.refresh').click();
        await eventually(() => {
          expect(
            workspace.requestLines.filter((l) => l.includes('/overview')),
          ).toHaveLength(2);
        });

        // The record: every REST request is on the allow-list, and every id the engine would run is a read or
        // one of the two view commands (no plan, no execute, no other action).
        const requests = beds.flatMap((bed) => bed.engine.requests);
        expect(requests.length).toBeGreaterThan(8);
        const lines = requests.map(line);
        expect(lines.filter((l) => !ALLOWED.some((p) => p.test(l)))).toEqual(
          [],
        );
        const kinds = new Set(
          lines.map((l) => ALLOWED.findIndex((p) => p.test(l))),
        );
        // inventory.query, overview.get, profile.get, views.list, views.create and views.delete all ran (the
        // in-memory carrier needs no ticket, so the ticket entry of the list is never used here).
        expect([...kinds].sort()).toEqual([0, 1, 2, 3, 4, 5]);
        expect(lines.some((l) => /\/(plan|execute)\b/.test(l))).toBe(false);

        // The live side: every subscription is `explorer.window`, and at least one was made.
        const subs = beds
          .flatMap((bed) => bed.engine.clientFrames)
          .filter((frame) => frame.t === 'sub');
        expect(subs.length).toBeGreaterThan(0);
        for (const frame of subs) expect(frame.topic).toBe('explorer.window');

        // No secret in any request: the explorer holds none, and sends no credential of its own.
        const sent = JSON.stringify(requests);
        expect(sent).not.toMatch(
          /password|secret|credential|authorization|bearer/i,
        );

        // And it never called `fetch`.
        expect(direct).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'with no connection the explorer makes no request and no subscription',
    async () => {
      const page = await mountPage(InventoryPage, {
        cid: null,
        engineBacked: true,
        inputs: { kind: 'queues' },
      });
      page.fixture.detectChanges();
      await page.fixture.whenStable();
      expect(page.engine.requests).toEqual([]);
      expect(page.engine.clientFrames).toEqual([]);
      expect(page.fake.queries).toEqual([]);
    },
    PAGE_TEST_TIMEOUT_MS,
  );
});
