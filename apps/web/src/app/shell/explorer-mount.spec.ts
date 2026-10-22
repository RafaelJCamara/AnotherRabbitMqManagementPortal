import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import type { TransportRequest, TransportResponse } from '@app/ui-platform';
import { jsonResponse } from '@app/ui-platform/testing';
import { describe, expect, it } from 'vitest';

import { EXPLORER_TREE_SOURCE } from './explorer-tree/explorer-tree-source';
import { isSafeTabUrl } from './layout/shell-layout';
import { ShellLayoutStore } from './layout/shell-layout-store';
import { StatusBackend } from './status-bar/status-fixtures';
import { mountShell, routed, settleShell, until, visit } from './test-fixtures';

const FRESHNESS = {
  state: 'live',
  complete: true,
  loaded: 0,
  truncated: false,
  dropped: 0,
  hazards: [],
  versionChanged: false,
};

const OVERVIEW = {
  product: 'RabbitMQ',
  totals: {},
  rates: { state: 'unavailable', reason: 'not-reported' },
  nodes: [],
  alarms: { state: 'none' },
  freshness: FRESHNESS,
};

/** The engine behind the shell, with what the explorer's pages ask for: an empty inventory and an overview. */
class ExplorerBackend extends StatusBackend {
  readonly inventory: { cid: string; body: Record<string, unknown> }[] = [];

  override async handle(request: TransportRequest): Promise<TransportResponse> {
    const url = new URL(request.url, 'http://engine.test');
    const path = url.pathname;
    if (request.method === 'GET' && path.endsWith('/overview')) {
      return jsonResponse(200, OVERVIEW);
    }
    if (request.method === 'GET' && path === '/api/v1/views') {
      return jsonResponse(200, { items: [] });
    }
    const inventory = /\/connections\/([^/]+)\/inventory\/queries$/.exec(path);
    if (request.method === 'POST' && inventory?.[1] !== undefined) {
      const body = JSON.parse(
        typeof request.body === 'string' ? request.body : '{}',
      ) as Record<string, unknown>;
      this.inventory.push({ cid: inventory[1], body });
      return jsonResponse(200, {
        kind: body.kind,
        rows: [],
        window: { offset: 0, limit: 200 },
        total: 0,
        matched: 0,
        version: 1,
        freshness: FRESHNESS,
      });
    }
    return await super.handle(request);
  }
}

/**
 * The timeout of the spec that mounts every explorer address under the real shell: five grid and overview pages,
 * each with AG Grid in jsdom (no layout), over vitest's 5 s default on a shared CI runner. Nothing sleeps.
 */
const MOUNT_TEST_TIMEOUT_MS = 20_000;

describe('the explorer under the shell', () => {
  it(
    'M0-54 AC-24 the explorer routes mount under c/:cid and the tree opens them',
    async () => {
      const backend = new ExplorerBackend();
      const bed = await mountShell(undefined, backend);

      // Each known address renders its view under the shell: the overview, a grid per kind.
      // The page's words arrive after the router settles (the scope is a lazy chunk): wait for the heading, not for a guess.
      const heading = (selector: string): string | undefined =>
        routed(bed).querySelector(selector)?.textContent;
      await visit(bed, '/c/c1/explorer');
      await until(
        bed,
        () => heading('main app-overview h1') !== undefined,
        'the overview heading',
      );
      let host = routed(bed);
      expect(host.tagName.toLowerCase()).toBe('app-shell');
      expect(host.querySelector('main app-overview h1')?.textContent).toBe(
        '[[explorer.overview.title]]',
      );
      expect(host.querySelector('app-explorer-home')).toBeNull(); // the placeholder is gone

      await visit(bed, '/c/c1/explorer/queues');
      await until(
        bed,
        () => heading('main app-inventory-page h1') !== undefined,
        'the queues heading',
      );
      host = routed(bed);
      expect(
        host.querySelector('main app-inventory-page h1')?.textContent,
      ).toBe('[[explorer.kinds.queues]]');
      await visit(bed, '/c/c1/explorer/exchanges');
      await until(
        bed,
        () =>
          heading('main app-inventory-page h1') ===
          '[[explorer.kinds.exchanges]]',
        'the exchanges heading',
      );
      expect(
        routed(bed).querySelector('main app-inventory-page h1')?.textContent,
      ).toBe('[[explorer.kinds.exchanges]]');
      await visit(bed, '/c/c1/explorer/connections');
      await until(
        bed,
        () =>
          heading('main app-inventory-page h1') ===
          '[[explorer.kinds.connections]]',
        'the connections heading',
      );
      expect(
        routed(bed).querySelector('main app-inventory-page h1')?.textContent,
      ).toBe('[[explorer.kinds.connections]]');

      // Bindings read exactly one vhost, which the address carries.
      await visit(bed, '/c/c1/explorer/bindings?vhost=%2F');
      await until(
        bed,
        () =>
          heading('main app-inventory-page h1') ===
          '[[explorer.kinds.bindings]]',
        'the bindings heading',
      );
      expect(
        routed(bed).querySelector('main app-inventory-page h1')?.textContent,
      ).toBe('[[explorer.kinds.bindings]]');
      await bed.harness.fixture.whenStable();
      await settleShell(bed);
      const bindings = backend.inventory.filter(
        (call) => call.body.kind === 'bindings',
      );
      expect(bindings.length).toBeGreaterThan(0);
      for (const call of bindings) {
        expect(call.cid).toBe('c1');
        expect(call.body.filter).toEqual({ vhosts: ['/'] });
      }

      // An address the feature does not know is the shell's own not-found view.
      await visit(bed, '/c/c1/explorer/nope');
      host = routed(bed);
      expect(host.tagName.toLowerCase()).toBe('app-shell');
      expect(host.querySelector('main app-not-found')).not.toBeNull();
      expect(host.querySelector('app-overview, app-inventory-page')).toBeNull();

      // Every node of the tree is an address that resolves to a route and may be kept as a tab.
      const roots = TestBed.inject(EXPLORER_TREE_SOURCE).roots('c1')();
      expect(roots.map((node) => node.url)).toEqual([
        '/c/c1/explorer',
        '/c/c1/explorer/queues',
        '/c/c1/explorer/exchanges',
        '/c/c1/explorer/connections',
        '/c/c1/explorer/bindings',
      ]);
      for (const node of roots) {
        expect(node.url !== null && isSafeTabUrl(node.url, 'c1'), node.id).toBe(
          true,
        );
      }
      // Four of the five addresses were shown above; the fifth (the bindings without a vhost yet) resolves too.
      await visit(bed, '/c/c1/explorer/bindings');
      expect(routed(bed).querySelector('app-not-found')).toBeNull();
      expect(routed(bed).querySelector('app-inventory-page')).not.toBeNull();

      // Activating a node opens a tab with the node's label and shows its address.
      await visit(bed, '/c/c1/explorer');
      const items =
        routed(bed).querySelectorAll<HTMLElement>('[role="treeitem"]');
      items[2]?.click();
      await settleShell(bed);
      expect(
        TestBed.inject(ShellLayoutStore).layout().editor.groups[0]?.tabs,
      ).toEqual([
        {
          id: 't1',
          url: '/c/c1/explorer/exchanges',
          label: '[[shell.tree.kind.exchanges]]',
        },
      ]);
      expect(TestBed.inject(Router).url).toBe('/c/c1/explorer/exchanges');
      expect(
        routed(bed).querySelector('main app-inventory-page h1')?.textContent,
      ).toBe('[[explorer.kinds.exchanges]]');
    },
    MOUNT_TEST_TIMEOUT_MS,
  );

  it('M0-54 AC-24b a connection that is not a plain token shows no explorer content and the explorer makes no call', async () => {
    const backend = new ExplorerBackend();
    const bed = await mountShell(undefined, backend);
    const before = bed.engine.requests.length;
    await visit(bed, '/c/not%20an%20id/explorer/queues');
    const host = routed(bed);
    expect(host.querySelector('main app-no-connection')).not.toBeNull();
    expect(host.querySelector('app-inventory-page, app-overview')).toBeNull();
    expect(backend.inventory).toEqual([]);
    // The shell's switcher reads the list of connections; nothing names the connection that is not an id.
    expect(
      bed.engine.requests.filter(
        (request) => request.url !== '/api/v1/connections?limit=100',
      ).length,
    ).toBe(before);
  });
});
