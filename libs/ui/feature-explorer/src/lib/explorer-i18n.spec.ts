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
    'AC-25 every visible string of the overview and of a grid page is a key of the English file or engine data',
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
});
