// M0-54 AC-25, the mounted half: every visible string of the explorer is a Transloco key or engine data. The pages
// are mounted with a scope that answers `[[explorer.<path>]]` for every text, so the spec sees which key each text,
// `aria-label`, `title` and placeholder came from. The other half (every key literal of the source exists, every
// key is asked for, no forbidden claim, no `innerHTML`) reads the source as text and lives in the node project
// `web-gallery-check` (`explorer-i18n-source.test.mjs`), because this library is browser code and may not read files.
import { createFakeExplorerData } from '@app/explorer-model/testing';
import {
  eventually,
  restoreGridSpecEnvironment,
  warmUpGrid,
  WARM_UP_TIMEOUT_MS,
} from '@app/ui-grid/testing/components';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import en from '../i18n/en.json';
import { markedExplorerScope } from '../testing';
import { EXPLORER_SCOPE_LOADER } from './explorer-scope';
import { InventoryPage } from './grid/inventory-page.component';
import { OverviewPage } from './overview/overview.component';
import { PAGE_TEST_TIMEOUT_MS } from './testing/dom';
import { FakeWorkspace, problemOf } from './testing/fake-workspace';
import { mountPage } from './testing/page-testbed';
import { followerAt, mountEntity, queueRow } from './testing/entity-bed';

interface Tree {
  readonly [key: string]: string | Tree;
}

function leaves(tree: Tree, path: string): string[] {
  return Object.entries(tree).flatMap(([name, value]) =>
    typeof value === 'string'
      ? [`${path}.${name}`]
      : leaves(value, `${path}.${name}`),
  );
}

const KEYS = leaves(en, 'explorer');
const KEY_SET = new Set(KEYS);

/** The engine's own words and data the fixtures put on screen: names, numbers, node names, times, versions. */
const ENGINE_DATA: readonly RegExp[] = [
  /^[\d.,\s/]+(of [\d.,\s]+)?$/,
  /^T\d+$/,
  /^(queue|exchange)-\d+$/,
  /^(\d+\.){3}\d+/,
  /^(guest|rabbit@[a-c]|RabbitMQ|\d+\.\d+\.\d+|\/)$/,
  /^(classic|quorum|stream|direct|fanout|topic|headers|running|idle)$/,
];

/** Every visible string of a DOM subtree: text nodes and the attributes screen readers read. */
function visibleStrings(root: Element): string[] {
  const found: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text !== '') found.push(text);
      return;
    }
    if (node instanceof Element) {
      for (const name of ['aria-label', 'title', 'placeholder', 'alt']) {
        const value = node.getAttribute(name)?.trim();
        if (value) found.push(value);
      }
    }
    node.childNodes.forEach(walk);
  };
  walk(root);
  return found;
}

/** Splits what a page shows into the keys it asked for and the strings that are neither a key nor engine data. */
function classify(el: Element): { keys: Set<string>; strangers: string[] } {
  const keys = new Set<string>();
  const strangers: string[] = [];
  for (const text of visibleStrings(el)) {
    const markers = [...text.matchAll(/\[\[(explorer\.[A-Za-z0-9._-]+)\]\]/g)];
    if (markers.length > 0) {
      for (const marker of markers) {
        if (marker[1] !== undefined) keys.add(marker[1]);
      }
      // Whatever is left beside the markers must be punctuation or data.
      const rest = text.replace(/\[\[[^\]]*\]\]/g, '').trim();
      if (
        rest !== '' &&
        !/^[\s\d.,:;()/·–-]*$/.test(rest) &&
        !ENGINE_DATA.some((p) => p.test(rest))
      ) {
        strangers.push(text);
      }
    } else if (!ENGINE_DATA.some((pattern) => pattern.test(text))) {
      strangers.push(text);
    }
  }
  return { keys, strangers };
}

const scopeLoader = {
  provide: EXPLORER_SCOPE_LOADER,
  useValue: markedExplorerScope,
};

describe('the explorer strings', () => {
  beforeAll(warmUpGrid, WARM_UP_TIMEOUT_MS);
  afterAll(restoreGridSpecEnvironment);

  it(
    // The name the spec gives AC-25; the claims half of it is the node test of `web-gallery-check`.
    'AC-25 every visible string is a Transloco key or engine data and none makes a forbidden claim',
    async () => {
      const workspace = new FakeWorkspace();
      workspace.overview = () => ({
        product: 'RabbitMQ',
        version: '4.3.6',
        clusterName: 'rabbit@a',
        totals: { queues: 12, exchanges: 8, connections: 3, consumers: 5 },
        rates: { state: 'unavailable', reason: 'statistics-off' },
        nodes: [
          { name: 'rabbit@a', running: true, beingDrained: false },
          { name: 'rabbit@b', running: false },
          { name: 'rabbit@c', running: true, beingDrained: true },
        ],
        alarms: {
          state: 'active',
          active: [{ node: 'rabbit@a', resource: 'memory' }],
        },
        freshness: {
          state: 'loading',
          sweptAt: 1000,
          complete: false,
          loaded: 3,
          truncated: true,
          dropped: 2,
          hazards: [],
          versionChanged: false,
        },
      });
      const overview = await mountPage(OverviewPage, {
        workspace,
        providers: [scopeLoader],
        inputs: { time: (ms: number) => `T${String(ms)}` },
      });
      await eventually(() => {
        overview.fixture.detectChanges();
        expect(overview.el.querySelector('.region')).not.toBeNull();
      });
      const shown = classify(overview.el);
      expect(shown.strangers).toEqual([]);
      expect(shown.keys.size).toBeGreaterThan(10);
      for (const key of shown.keys) expect(KEY_SET.has(key), key).toBe(true);

      // The same page when the overview cannot be read: the engine's Problem is shown as sent.
      const failing = new FakeWorkspace();
      failing.failure.overview = problemOf(503, 'BROKER_ERROR', {
        title: 'Broker unreachable',
        detail: 'The overview could not be read.',
      });
      const failed = await mountPage(OverviewPage, {
        workspace: failing,
        providers: [scopeLoader],
      });
      await eventually(() => {
        failed.fixture.detectChanges();
        expect(failed.el.querySelector('[role="alert"]')).not.toBeNull();
      });
      const problem = classify(failed.el);
      for (const key of problem.keys) expect(KEY_SET.has(key), key).toBe(true);
      expect(
        problem.strangers.filter(
          (text) =>
            !/Broker unreachable|The overview could not be read\./.test(text),
        ),
      ).toEqual([]);

      // A grid page with its bar, banner, views control and column chooser, rendered by the real grid.
      const fake = createFakeExplorerData({
        rows: { queues: 30 },
        autoSnapshot: true,
      });
      const grid = await mountPage(InventoryPage, {
        fake,
        providers: [scopeLoader],
        inputs: { kind: 'queues' },
      });
      await eventually(() => {
        grid.fixture.detectChanges();
        expect(
          grid.el.querySelectorAll('.ag-row [col-id]').length,
        ).toBeGreaterThan(1);
      }, 8000);
      const page = classify(grid.el);
      for (const key of page.keys) expect(KEY_SET.has(key), key).toBe(true);
      // The cells are the fake's names, vhosts and counts; the headers are the page's own keys.
      const cells = [
        ...grid.el.querySelectorAll('.ag-body-viewport *'),
      ].flatMap((node) =>
        [...node.childNodes].filter(
          (child) => child.nodeType === Node.TEXT_NODE,
        ),
      );
      const cellText = new Set(
        cells.map((node) =>
          (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
        ),
      );
      expect(page.strangers.filter((text) => !cellText.has(text))).toEqual([]);
      expect(page.keys.size).toBeGreaterThan(10);
    },
    PAGE_TEST_TIMEOUT_MS,
  );
  it(
    'AC-19 the entity strings are keys and make no forbidden claim',
    async () => {
      const row = queueRow('queue-00001', {
        type: 'quorum',
        state: 'running',
        node: 'rabbit@a',
        durable: true,
        messages: 5,
        consumers: 1,
      });
      const stream = queueRow('queue-00002', { type: 'stream', state: 'idle' });
      const gone = queueRow('queue-00003');
      const keysOf = (shown: { keys: Set<string> }): void => {
        for (const key of shown.keys) expect(KEY_SET.has(key), key).toBe(true);
      };

      // Found: the header, the actions, the strip with its reasons, the fields and the notes, in every tab.
      const seen = new Set<string>();
      for (const tab of [null, 'config', 'consumers', 'messages', 'nope']) {
        const bed = await mountEntity({
          rows: [row],
          tab,
          providers: [scopeLoader],
        });
        await eventually(() => {
          bed.fixture.detectChanges();
          expect(bed.el.querySelector('[role="tabpanel"]')).not.toBeNull();
        }, 8000);
        const shown = classify(bed.el);
        expect(shown.strangers).toEqual([]);
        keysOf(shown);
        for (const key of shown.keys) seen.add(key);
      }
      // The Routing tab of a queue and of an exchange (no bindings in this inventory: the empty sentences).
      for (const kind of ['queues', 'exchanges'] as const) {
        const routing = await mountEntity({
          kind,
          rows: [kind === 'queues' ? row : queueRow('queue-00009')],
          tab: 'routing',
          providers: [scopeLoader],
        });
        await eventually(() => {
          routing.fixture.detectChanges();
          expect(
            routing.el.querySelector('app-routing-panel h2'),
          ).not.toBeNull();
        }, 8000);
        const shown = classify(routing.el);
        expect(shown.strangers).toEqual([]);
        keysOf(shown);
        for (const key of shown.keys) seen.add(key);
      }
      // A stream on its gated tab, a removed object, a missing one, a failed read and an invalid address.
      const gated = await mountEntity({
        rows: [stream],
        tab: 'browse',
        providers: [scopeLoader],
      });
      await eventually(() => {
        gated.fixture.detectChanges();
        expect(
          gated.el.querySelector('[role="tabpanel"]'),
          gated.el.innerHTML,
        ).not.toBeNull();
      }, 8000);
      keysOf(classify(gated.el));
      expect(classify(gated.el).strangers).toEqual([]);

      const vanished = await mountEntity({
        rows: [row],
        providers: [scopeLoader],
      });
      await eventually(() => {
        expect(vanished.el.querySelector('dl.fields')).not.toBeNull();
        vanished.fixture.detectChanges();
      }, 8000);
      vanished.fake.emit({ kind: 'delta', upserts: [], removes: [row.key] });
      vanished.fake.emit({ kind: 'error', error: new Error('closed') });
      await eventually(() => {
        vanished.fixture.detectChanges();
        expect(
          vanished.el.querySelector('.warn'),
          vanished.el.innerHTML,
        ).not.toBeNull();
      });
      for (const key of classify(vanished.el).keys) seen.add(key);

      const missing = await mountEntity({
        rows: [row],
        key: gone.key,
        providers: [scopeLoader],
      });
      await eventually(() => {
        missing.fixture.detectChanges();
        expect(
          missing.el.querySelector('.state p'),
          missing.el.innerHTML,
        ).not.toBeNull();
      }, 8000);
      const absent = classify(missing.el);
      keysOf(absent);
      expect(absent.strangers).toEqual([]);
      for (const key of absent.keys) seen.add(key);

      const failed = await mountEntity({
        rows: [row],
        autoSnapshot: false,
        providers: [scopeLoader],
      });
      await eventually(() => {
        expect(failed.fake.followers).toHaveLength(1);
      });
      failed.fake.emit({
        kind: 'error',
        error: new Error('The broker said no'),
      });
      await eventually(() => {
        failed.fixture.detectChanges();
        expect(failed.el.querySelector('[role="alert"]')).not.toBeNull();
      });
      const broken = classify(failed.el);
      keysOf(broken);
      expect(
        broken.strangers.filter((text) => text !== 'The broker said no'),
      ).toEqual([]);
      expect(followerAt(failed.fake).active).toBe(true);

      const invalid = await mountEntity({
        rows: [row],
        key: 'not*a*key',
        providers: [scopeLoader],
      });
      await eventually(() => {
        invalid.fixture.detectChanges();
        expect(
          invalid.el.querySelector('.state'),
          invalid.el.innerHTML,
        ).not.toBeNull();
      });
      keysOf(classify(invalid.el));
      expect(classify(invalid.el).strangers).toEqual([]);
      for (const key of classify(invalid.el).keys) seen.add(key);

      // Between them the states used a good part of the entity keys.
      expect(
        [...seen].filter((key) => key.startsWith('explorer.entity.')).length,
      ).toBeGreaterThan(20);
    },
    PAGE_TEST_TIMEOUT_MS,
  );
});
