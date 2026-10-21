import { Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import type { GridCellTarget, GridMenuProvider } from './context-menu';
import { DataGrid } from './data-grid.component';
import {
  cellAt,
  COLUMNS,
  key,
  LABELS,
  rendered,
  ROWS,
  settled,
  source,
  type Row,
} from './grid-spec-support';
import type { GridKeybinding } from './keybindings';
import { provideGridRenderAll } from './testing/render-all';

@Component({
  imports: [DataGrid],
  template: `
    <div style="height: 400px">
      <app-data-grid
        [columns]="columns"
        [source]="source"
        [labels]="labels"
        [contextMenu]="provider()"
        [keybindings]="keybindings()"
        (menuAction)="actions.push($event)"
      />
    </div>
  `,
})
class Host {
  readonly columns = COLUMNS;
  readonly source = source();
  readonly labels = LABELS;
  readonly provider = signal<GridMenuProvider<Row> | null>(null);
  readonly keybindings = signal<readonly GridKeybinding<Row>[] | undefined>(
    undefined,
  );
  readonly actions: { itemId: string; target: GridCellTarget<Row> }[] = [];
}

async function mount(provider: GridMenuProvider<Row> | null) {
  TestBed.configureTestingModule({ providers: [provideGridRenderAll()] });
  const fixture: ComponentFixture<Host> = TestBed.createComponent(Host);
  fixture.componentInstance.provider.set(provider);
  const el = fixture.nativeElement as HTMLElement;
  document.body.append(el);
  await fixture.whenStable();
  await rendered(el, 3);
  return { fixture, host: fixture.componentInstance, el };
}

const menuOf = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="menu"]');
const items = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
];
const at = <T>(list: readonly T[], index: number): T => {
  const found = list[index];
  if (found === undefined) throw new Error(`No item ${String(index)}`);
  return found;
};
const item = (index: number): HTMLElement => at(items(), index);
const active = (): HTMLElement => {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) throw new Error('Nothing has focus');
  return el;
};
const text = (el: Element | null): string =>
  (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

function rightClick(cell: Element): MouseEvent {
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 40,
    clientY: 30,
  });
  cell.dispatchEvent(event);
  return event;
}

const SIMPLE: GridMenuProvider<Row> = () => [
  { kind: 'plain', id: 'open', label: 'Open' },
  { kind: 'separator' },
  { kind: 'plain', id: 'copy', label: 'Copy name' },
  { kind: 'plain', id: 'purge', label: 'Purge' },
];

describe('grid context menu', () => {
  it('AC-2 right-click opens the app menu and nothing else', async () => {
    const { el, fixture, host } = await mount(SIMPLE);
    const cell = cellAt(el, 'name', 1);
    cell.focus();
    const event = rightClick(cell);

    // Only our menu: the native and the AG Grid menus are off.
    await settled(fixture, () => {
      expect(menuOf()).not.toBeNull();
    });
    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    expect(
      document.querySelector('.ag-menu, .ag-popup, .ag-context-menu'),
    ).toBeNull();
    expect(menuOf()?.getAttribute('aria-label')).toBe('Row actions');
    expect(items().map((i) => text(i))).toEqual(['Open', 'Copy name', 'Purge']);
    expect(document.querySelectorAll('[role="separator"]')).toHaveLength(1);
    // Focus is on the first enabled item.
    expect(document.activeElement).toBe(items()[0]);

    // Arrows, Home and End move, and wrap.
    key(item(0), 'ArrowDown');
    expect(document.activeElement).toBe(items()[1]);
    key(active(), 'End');
    expect(document.activeElement).toBe(items()[2]);
    key(active(), 'ArrowDown');
    expect(document.activeElement).toBe(items()[0]);
    key(active(), 'ArrowUp');
    expect(document.activeElement).toBe(items()[2]);
    key(active(), 'Home');
    expect(document.activeElement).toBe(items()[0]);

    // Escape closes the menu and returns focus to the cell.
    key(active(), 'Escape');
    await settled(fixture, () => {
      expect(menuOf()).toBeNull();
    });
    expect(document.activeElement).toBe(cell);
    expect(host.actions).toEqual([]);
  });

  it('chooses an item with Enter or a click, emits it with the cell it was opened on, and closes', async () => {
    const { el, fixture, host } = await mount(SIMPLE);
    const cell = cellAt(el, 'size', 2);
    rightClick(cell);
    await settled(fixture, () => {
      expect(menuOf()).not.toBeNull();
    });
    key(item(0), 'ArrowDown');
    key(active(), 'Enter');
    await settled(fixture, () => {
      expect(menuOf()).toBeNull();
    });
    expect(host.actions).toEqual([
      {
        itemId: 'copy',
        target: { rowId: 'c', row: ROWS[2], columnId: 'size' },
      },
    ]);

    rightClick(cell);
    await settled(fixture, () => {
      expect(menuOf()).not.toBeNull();
    });
    items()[2]?.click();
    await settled(fixture, () => {
      expect(menuOf()).toBeNull();
    });
    expect(host.actions.map((a) => a.itemId)).toEqual(['copy', 'purge']);
  });

  it('does nothing without a provider', async () => {
    const { el } = await mount(null);
    rightClick(cellAt(el, 'name', 0));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(menuOf()).toBeNull();
  });

  it('does nothing when the provider offers no items', async () => {
    const { el } = await mount(() => []);
    rightClick(cellAt(el, 'name', 0));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(menuOf()).toBeNull();
  });
  it('closes when focus leaves the menu', async () => {
    const { el, fixture } = await mount(SIMPLE);
    rightClick(cellAt(el, 'name', 0));
    await settled(fixture, () => {
      expect(menuOf()).not.toBeNull();
    });
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    await settled(fixture, () => {
      expect(menuOf()).toBeNull();
    });
    outside.remove();
  });

  it('opens from the keyboard with Shift+F10 and with the context-menu key, on the focused cell', async () => {
    const { el, fixture, host } = await mount(SIMPLE);
    const cell = cellAt(el, 'name', 1);
    cell.focus();
    key(cell, 'F10', { shiftKey: true });
    await settled(fixture, () => {
      expect(menuOf()).not.toBeNull();
    });
    key(active(), 'Escape');
    await settled(fixture, () => {
      expect(menuOf()).toBeNull();
    });
    expect(document.activeElement).toBe(cell);
    key(cell, 'ContextMenu');
    await settled(fixture, () => {
      expect(menuOf()).not.toBeNull();
    });
    key(active(), 'Enter');
    await settled(fixture, () => {
      expect(host.actions).toHaveLength(1);
    });
    expect(host.actions[0]?.target).toEqual({
      rowId: 'b',
      row: ROWS[1],
      columnId: 'name',
    });
  });

  it('uses the keybindings it is given instead of the defaults', async () => {
    const { el, fixture, host } = await mount(SIMPLE);
    const seen: string[] = [];
    host.keybindings.set([
      {
        id: 'custom.menu',
        chord: { key: 'm', ctrlOrMeta: true },
        run: (context) => {
          seen.push(context.target.rowId);
          context.openMenu();
        },
      },
    ]);
    await fixture.whenStable();
    const cell = cellAt(el, 'name', 0);
    cell.focus();
    key(cell, 'F10', { shiftKey: true }); // a default no longer in force
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(menuOf()).toBeNull();
    key(cell, 'M', { ctrlKey: true });
    await settled(fixture, () => {
      expect(menuOf()).not.toBeNull();
    });
    expect(seen).toEqual(['a']);
  });

  it('AC-14 a closed gate never activates a menu item', async () => {
    const provider: GridMenuProvider<Row> = () => [
      {
        kind: 'gated',
        id: 'open-gate',
        label: 'Allowed',
        gate: { enabled: true },
      },
      {
        kind: 'gated',
        id: 'closed-gate',
        label: 'Purge',
        gate: {
          enabled: false,
          reason: 'Purge is locked on prod until armed',
          source: 'prod-lock',
        },
      },
      { kind: 'gated', id: 'missing-gate', label: 'Move', gate: undefined },
      { kind: 'gated', id: 'null-gate', label: 'Delete', gate: null },
      {
        kind: 'gated',
        id: 'bad-gate',
        label: 'Shovel',
        gate: { enabled: 'true' } as never,
      },
      {
        kind: 'gated',
        id: 'degraded-gate',
        label: 'Peek',
        gate: {
          enabled: true,
          mode: 'degraded',
          reason: 'Stats are off, totals only',
        },
      },
    ];
    const { el, fixture, host } = await mount(provider);
    rightClick(cellAt(el, 'name', 0));
    await settled(fixture, () => {
      expect(menuOf()).not.toBeNull();
    });
    const all = items();
    const closed = ['Purge', 'Move', 'Delete', 'Shovel'];
    for (const item of all) {
      const label = text(item.querySelector('.item-label'));
      expect(item.getAttribute('aria-disabled') === 'true').toBe(
        closed.includes(label),
      );
    }

    // A closed item stays focusable, says why and from where, as text, and describes the item.
    const purge = at(all, 1);
    purge.focus();
    expect(document.activeElement).toBe(purge);
    const reasonOf = (item: HTMLElement): string =>
      text(
        document.getElementById(item.getAttribute('aria-describedby') ?? ''),
      );
    expect(reasonOf(purge)).toBe(
      'Why disabled Purge is locked on prod until armed Source prod-lock',
    );
    expect(reasonOf(at(all, 2))).toBe('Why disabled No reason given');
    expect(reasonOf(at(all, 3))).toBe('Why disabled No reason given');
    expect(reasonOf(at(all, 4))).toBe('Why disabled No reason given');
    // A degraded gate works and says what is limited.
    expect(all[5]?.getAttribute('aria-disabled')).toBeNull();
    expect(reasonOf(at(all, 5))).toBe('Limited Stats are off, totals only');
    // The enabled item has no reason.
    expect(all[0]?.getAttribute('aria-describedby')).toBeNull();

    // Activating every closed item, by click and by Enter and Space, emits nothing and keeps the menu.
    for (const index of [1, 2, 3, 4]) {
      const closedItem = at(all, index);
      closedItem.click();
      closedItem.focus();
      key(closedItem, 'Enter');
      key(closedItem, ' ');
    }
    expect(host.actions).toEqual([]);
    expect(menuOf()).not.toBeNull();

    // The enabled item emits, once, and the menu closes.
    all[0]?.click();
    await settled(fixture, () => {
      expect(menuOf()).toBeNull();
    });
    expect(host.actions.map((a) => a.itemId)).toEqual(['open-gate']);
  });

  it('keeps the menu text-only: a label with markup is text', async () => {
    const { el, fixture } = await mount(() => [
      { kind: 'plain', id: 'x', label: '<img src=x onerror=alert(1)>' },
    ]);
    rightClick(cellAt(el, 'name', 0));
    await settled(fixture, () => {
      expect(menuOf()).not.toBeNull();
    });
    expect(menuOf()?.querySelector('img')).toBeNull();
    expect(text(items()[0] ?? null)).toBe('<img src=x onerror=alert(1)>');
    vi.restoreAllMocks();
  });
});
