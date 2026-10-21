import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { describe, expect, it } from 'vitest';

import {
  EXPLORER_TREE_SOURCE,
  type ExplorerNode,
  type ExplorerTreeSource,
} from './explorer-tree/explorer-tree-source';
import { LayoutBackend, twoGroupLayout } from './layout/layout-fixtures';
import { ShellLayoutStore } from './layout/shell-layout-store';
import {
  mountShell,
  routed,
  settleShell,
  visit,
  type ShellTestbed,
} from './test-fixtures';

const node = (
  id: string,
  label: string,
  children: ExplorerNode['children'],
  url: string | null = null,
): ExplorerNode => ({ id, label, url, children });

/** Alpha has Beta (which has a child of its own, not loaded); Zed is a leaf. */
const ROOTS = [
  node('a', 'Alpha', 'loaded', '/c/c1/alpha'),
  node('z', 'Zed', 'none', '/c/c1/zed'),
];
const CHILDREN: Readonly<Record<string, readonly ExplorerNode[]>> = {
  a: [node('b', 'Beta', 'lazy', '/c/c1/beta')],
  b: [node('d', 'Delta', 'none', '/c/c1/delta')],
};
const treeSource: ExplorerTreeSource = {
  roots: () => signal<readonly ExplorerNode[]>(ROOTS).asReadonly(),
  children: (id) => signal(CHILDREN[id] ?? []).asReadonly(),
};

const press = async (
  bed: ShellTestbed,
  target: Element | null | undefined,
  key: string,
): Promise<KeyboardEvent> => {
  if (!(target instanceof HTMLElement))
    throw new Error(`no element for ${key}`);
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  await settleShell(bed);
  return event;
};

const active = (): string | null => {
  const element = document.activeElement;
  return element instanceof HTMLElement
    ? (element.dataset.node ?? element.dataset.tab ?? element.id)
    : null;
};

describe('shell', () => {
  it('AC-10 the regions are operable by keyboard with correct roles and focus', async () => {
    const backend = new LayoutBackend();
    backend.docs.set('c1', twoGroupLayout('c1'));
    const bed = await mountShell(undefined, backend, undefined, [
      { provide: EXPLORER_TREE_SOURCE, useValue: treeSource },
    ]);
    await visit(bed, '/c/c1/explorer');
    const host = routed(bed);
    const store = TestBed.inject(ShellLayoutStore);
    const all = (selector: string) => [
      ...host.querySelectorAll<HTMLElement>(selector),
    ];

    // Every region is a landmark or a labelled role.
    for (const selector of [
      'nav[aria-label]',
      'aside[aria-label]',
      'main[aria-label]',
      'footer[aria-label]',
      'section[aria-label]',
      '[role="tree"][aria-label]',
      '[role="tablist"][aria-label]',
      '[role="separator"][aria-label]',
    ]) {
      expect(all(selector).length, selector).toBeGreaterThan(0);
      for (const element of all(selector)) {
        expect(element.getAttribute('aria-label')?.trim(), selector).not.toBe(
          '',
        );
      }
    }
    expect(all('section[aria-label]')).toHaveLength(2);

    // The tab strip: tabs roles, one tab stop, roving focus, manual activation, Delete closes.
    const strip = (group: number) =>
      all('app-tab-strip')[group]?.querySelectorAll<HTMLElement>(
        '[role="tab"]',
      );
    const tabs = [...(strip(0) ?? [])];
    expect(tabs.map((t) => t.textContent.trim())).toEqual([
      'One',
      'Two',
      'Three',
    ]);
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
    ]);
    expect(tabs.map((t) => t.getAttribute('tabindex'))).toEqual([
      '-1',
      '0',
      '-1',
    ]);
    expect(
      all('app-tab-strip [role="tablist"]')[0]?.getAttribute(
        'aria-orientation',
      ),
    ).toBe('horizontal');
    tabs[1]?.focus();
    await press(bed, tabs[1], 'ArrowRight');
    expect(active()).toBe('t3');
    await press(bed, tabs[2], 'ArrowRight'); // wraps
    expect(active()).toBe('t1');
    await press(bed, tabs[0], 'End');
    expect(active()).toBe('t3');
    await press(bed, tabs[2], 'Home');
    expect(active()).toBe('t1');
    // Focus moves without activating; the roving stop follows the focus.
    expect(store.layout().editor.groups[0]?.activeTab).toBe('t2');
    expect(strip(0)?.[0]?.getAttribute('tabindex')).toBe('0');
    // Enter (a click on a button) shows the tab: the address follows.
    strip(0)?.[2]?.click();
    await settleShell(bed);
    expect(TestBed.inject(Router).url).toBe('/c/c1/three');
    expect(store.layout().editor.groups[0]?.activeTab).toBe('t3');
    // Delete closes the active tab and moves focus to its neighbour.
    strip(0)?.[2]?.focus();
    await press(bed, strip(0)?.[2], 'Delete');
    expect(store.layout().editor.groups[0]?.tabs.map((t) => t.id)).toEqual([
      't1',
      't2',
    ]);
    expect(store.layout().editor.groups[0]?.activeTab).toBe('t2');
    expect(active()).toBe('t2');
    expect(TestBed.inject(Router).url).toBe('/c/c1/two');
    // Closing a tab that is not the active one leaves the active tab alone.
    await press(bed, strip(0)?.[0], 'Delete');
    expect(store.layout().editor.groups[0]?.tabs.map((t) => t.id)).toEqual([
      't2',
    ]);
    expect(active()).toBe('t2');
    // The last tab: focus goes to the group.
    await press(bed, strip(0)?.[0], 'Delete');
    expect(store.layout().editor.groups[0]?.tabs).toEqual([]);
    expect(active()).toBe('group-body-0');

    // The tree: roles, one tab stop, arrows, expand and collapse, Home and End.
    const items = () => all('[role="treeitem"]');
    expect(items().map((i) => i.textContent.trim())).toEqual(['Alpha', 'Zed']);
    expect(items().map((i) => i.getAttribute('tabindex'))).toEqual(['0', '-1']);
    expect(items().map((i) => i.getAttribute('aria-level'))).toEqual([
      '1',
      '1',
    ]);
    expect(items()[0]?.getAttribute('aria-expanded')).toBe('false');
    expect(items()[1]?.hasAttribute('aria-expanded')).toBe(false);
    items()[0]?.focus();
    await press(bed, items()[0], 'ArrowDown');
    expect(active()).toBe('z');
    await press(bed, items()[1], 'ArrowUp');
    expect(active()).toBe('a');
    await press(bed, items()[0], 'End');
    expect(active()).toBe('z');
    await press(bed, items()[1], 'Home');
    expect(active()).toBe('a');
    await press(bed, items()[0], 'ArrowRight'); // expand
    expect(items().map((i) => i.textContent.trim())).toEqual([
      'Alpha',
      'Beta',
      'Zed',
    ]);
    expect(items()[0]?.getAttribute('aria-expanded')).toBe('true');
    expect(items()[1]?.getAttribute('aria-level')).toBe('2');
    expect(active()).toBe('a');
    await press(bed, items()[0], 'ArrowRight'); // into the first child
    expect(active()).toBe('b');
    await press(bed, items()[1], 'ArrowLeft'); // to the parent
    expect(active()).toBe('a');
    await press(bed, items()[0], 'ArrowLeft'); // collapse
    expect(items().map((i) => i.textContent.trim())).toEqual(['Alpha', 'Zed']);
    expect(items()[0]?.getAttribute('aria-expanded')).toBe('false');
    // Enter opens the node's address in a tab and shows it.
    await press(bed, items()[0], 'Enter');
    expect(store.layout().editor.groups[0]?.tabs.map((t) => t.url)).toEqual([
      '/c/c1/alpha',
    ]);
    expect(TestBed.inject(Router).url).toBe('/c/c1/alpha');

    // Splitters: separators with a value and bounds, moved by the arrows within the bounds.
    const separators = () => all('[role="separator"]');
    expect(separators()).toHaveLength(2); // sidebar, and between the two groups
    for (const separator of separators()) {
      const [now, min, max] = [
        'aria-valuenow',
        'aria-valuemin',
        'aria-valuemax',
      ].map((name) => Number(separator.getAttribute(name)));
      expect(
        Number.isFinite(now) && Number.isFinite(min) && Number.isFinite(max),
      ).toBe(true);
      expect(min).toBeLessThanOrEqual(now ?? 0);
      expect(now).toBeLessThanOrEqual(max ?? 0);
      expect(separator.getAttribute('tabindex')).toBe('0');
    }
    const sidebar = separators()[0];
    expect(sidebar?.getAttribute('aria-orientation')).toBe('vertical');
    await press(bed, sidebar, 'ArrowRight');
    expect(store.layout().sidebar.width).toBe(276);
    expect(separators()[0]?.getAttribute('aria-valuenow')).toBe('276');
    await press(bed, separators()[0], 'ArrowLeft');
    await press(bed, separators()[0], 'ArrowLeft');
    expect(store.layout().sidebar.width).toBe(244);
    await press(bed, separators()[0], 'End');
    const widest = Number(separators()[0]?.getAttribute('aria-valuemax'));
    expect(store.layout().sidebar.width).toBe(widest);
    await press(bed, separators()[0], 'ArrowRight'); // already at the bound
    expect(store.layout().sidebar.width).toBe(widest);
    await press(bed, separators()[0], 'Home');
    expect(store.layout().sidebar.width).toBe(
      Number(separators()[0]?.getAttribute('aria-valuemin')),
    );
    const share = () => {
      const [first = 0, second = 0] = store
        .layout()
        .editor.groups.map((g) => g.weight);
      return first / (first + second);
    };
    const wasShare = share();
    await press(bed, separators()[1], 'ArrowRight');
    expect(share()).toBeGreaterThan(wasShare);
    expect(store.layout().editor.groups.every((g) => g.weight > 0)).toBe(true);

    // A visible focus ring from the design tokens on everything that takes focus.
    const css = [...document.querySelectorAll('style')]
      .map((style) => style.textContent)
      .join('\n');
    // (the component styles are scoped: `.item[_ngcontent-x]:focus-visible`, `[_nghost-x]:...`)
    const scope = '(\\[[^\\]]*\\])*';
    for (const part of [
      `button${scope}:focus-visible`,
      `\\.item${scope}:focus-visible`,
      `\\[_nghost[^\\]]*\\]:focus-visible`,
      `\\.group-body${scope}:focus-visible`,
    ]) {
      const rule = new RegExp(`${part}[^{]*\\{[^}]*\\}`).exec(css)?.[0];
      expect(rule, part).toMatch(/outline:\s*var\(--ds-focus-ring-width\)/);
      expect(rule, part).toMatch(/var\(--ds-color-focus-ring\)/);
    }
  });
});
