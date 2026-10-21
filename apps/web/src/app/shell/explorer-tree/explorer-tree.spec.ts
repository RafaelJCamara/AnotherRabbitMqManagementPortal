import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { describe, expect, it } from 'vitest';

import { LayoutBackend, twoGroupLayout } from '../layout/layout-fixtures';
import { ShellLayoutStore } from '../layout/shell-layout-store';
import { mountShell, routed, settleShell, visit } from '../test-fixtures';
import {
  EXPLORER_TREE_ROW_LIMIT,
  EXPLORER_TREE_SOURCE,
  connectionRootSource,
  type ExplorerNode,
} from './explorer-tree-source';

describe('explorer tree', () => {
  it('shows the connection itself by default and opens it as a tab', async () => {
    const bed = await mountShell();
    await visit(bed, '/c/c1/explorer');
    const items = routed(bed).querySelectorAll('[role="treeitem"]');
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent.trim()).toBe('c1');
    expect(items[0]?.hasAttribute('aria-expanded')).toBe(false);

    (items[0] as HTMLElement).click();
    await settleShell(bed);
    const tabs =
      TestBed.inject(ShellLayoutStore).layout().editor.groups[0]?.tabs;
    expect(tabs).toEqual([{ id: 't1', url: '/c/c1/explorer', label: 'c1' }]);
    expect(TestBed.inject(Router).url).toBe('/c/c1/explorer');
    // The same node again activates the tab it has; it does not open another.
    (items[0] as HTMLElement).click();
    await settleShell(bed);
    expect(
      TestBed.inject(ShellLayoutStore).layout().editor.groups[0]?.tabs,
    ).toHaveLength(1);
  });

  it('follows the connection: the default source answers per connection', () => {
    const source = connectionRootSource();
    expect(source.roots('c1')()[0]?.url).toBe('/c/c1/explorer');
    expect(source.roots('c2')()[0]?.url).toBe('/c/c2/explorer');
    expect(source.roots('c2')).toBe(source.roots('c2'));
    expect(source.children('connection:c1')()).toEqual([]);
  });

  it('draws at most the row limit and says the list is longer (I-7)', async () => {
    const nodes: readonly ExplorerNode[] = Array.from(
      { length: EXPLORER_TREE_ROW_LIMIT + 50 },
      (_, i) => ({
        id: `n${String(i)}`,
        label: `Node ${String(i)}`,
        url: null,
        children: 'none',
      }),
    );
    const bed = await mountShell(undefined, undefined, undefined, [
      {
        provide: EXPLORER_TREE_SOURCE,
        useValue: {
          roots: () => signal(nodes).asReadonly(),
          children: () => signal<readonly ExplorerNode[]>([]).asReadonly(),
        },
      },
    ]);
    await visit(bed, '/c/c1/explorer');
    const host = routed(bed);
    expect(host.querySelectorAll('[role="treeitem"]')).toHaveLength(
      EXPLORER_TREE_ROW_LIMIT,
    );
    expect(
      host.querySelector('app-explorer-tree .hint')?.textContent.trim(),
    ).toBe('[[shell.tree.truncated]]');
  });

  it('a refused tab does not navigate: the notice says why and the address stays', async () => {
    const backend = new LayoutBackend();
    const crowded = twoGroupLayout('c1');
    // Group 0 is full: thirty tabs, none of them the connection's explorer address.
    backend.docs.set('c1', {
      ...crowded,
      editor: {
        ...crowded.editor,
        groups: [
          {
            weight: 600,
            tabs: Array.from({ length: 30 }, (_, i) => ({
              id: `x${String(i + 1)}`,
              url: `/c/c1/q${String(i)}`,
              label: `q${String(i)}`,
            })),
            activeTab: 'x1',
          },
          crowded.editor.groups[1] ?? { weight: 1, tabs: [], activeTab: null },
        ],
      },
    });
    const bed = await mountShell(undefined, backend);
    await visit(bed, '/c/c1/explorer');
    const before = TestBed.inject(Router).url;
    routed(bed).querySelector<HTMLElement>('[role="treeitem"]')?.click();
    await settleShell(bed);
    expect(TestBed.inject(Router).url).toBe(before);
    expect(
      TestBed.inject(ShellLayoutStore).layout().editor.groups[0]?.tabs,
    ).toHaveLength(30);
    expect(
      routed(bed).querySelector('app-layout-notices')?.textContent,
    ).toContain('[[shell.refusal.tabsPerGroup]]');
  });
});
