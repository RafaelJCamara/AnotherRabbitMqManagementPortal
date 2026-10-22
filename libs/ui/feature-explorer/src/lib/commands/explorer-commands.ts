// The commands of the explorer's pages (M1-41, R14): what a person can do from the keyboard or the command palette
// on an inventory page (focus the filter, reload the list, save the view, choose the columns, copy the selected
// rows) and on the overview (refresh). A page registers them while it lives and they go with it. None of them
// sends anything the page does not already send: they press the page's own controls. The one that calls the engine,
// saving a view, names its action (`views.create`), so it is closed with the engine's own words unless the engine's
// `allowedActions` has it. Row activation and the grid's context menu are not here: there is no entity page to
// open yet (M1-42), and no command that changes the broker exists in this feature.
import { DestroyRef, effect, inject, type Signal } from '@angular/core';
import {
  CommandContext,
  registerCommands,
  scopedText,
  type CommandDefinition,
} from '@app/ui-commands';
import type { ProviderScope } from '@jsverse/transloco';

import { EXPLORER_SCOPE, EXPLORER_SCOPE_LOADER } from '../explorer-scope';
import type { ExplorerKind } from '@app/explorer-model';

/** The default chords of the explorer's commands: a bare `/` focuses the filter (ignored while typing in a field). */
export const EXPLORER_DEFAULT_CHORDS: readonly string[] = ['/'];

/** The ids of the commands of an inventory page. */
export const INVENTORY_COMMAND_IDS = [
  'inventory.focus-filter',
  'inventory.reload',
  'inventory.save-view',
  'inventory.columns',
  'inventory.copy',
] as const;

/** The id of the command of the overview page. */
export const OVERVIEW_COMMAND_ID = 'overview.refresh';

function explorerScope(): ProviderScope {
  const load = inject(EXPLORER_SCOPE_LOADER);
  return { scope: EXPLORER_SCOPE, loader: { en: () => load() } };
}

/** Text of a full key of the explorer's scope (`explorer.commands.reload`), as a signal-backed function. */
function text(scope: ProviderScope, key: `explorer.${string}`): () => string {
  return scopedText(scope, key.slice(EXPLORER_SCOPE.length + 1));
}

export interface InventoryPageCommands {
  readonly kind: Signal<ExplorerKind>;
  /** A list is open: the engine has a profile and the page has made its source. */
  hasList(): boolean;
  /** The grid exists, so it has a column chooser. */
  hasGrid(): boolean;
  hasSelection(): boolean;
  focusFilter(): void;
  reload(): void;
  saveView(): void;
  chooseColumns(): void;
  copy(): Promise<void>;
}

/** Registers the commands of an inventory page. Call it in the page's injection context. */
export function registerInventoryCommands(page: InventoryPageCommands): void {
  const scope = explorerScope();
  const context = inject(CommandContext);
  const category = text(scope, 'explorer.commands.category');
  const noList = text(scope, 'explorer.commands.noList');
  const noGrid = text(scope, 'explorer.commands.noGrid');
  const noSelection = text(scope, 'explorer.commands.noSelection');
  const here = (get: (key: string) => unknown): boolean =>
    get('page') === 'inventory';

  inject(DestroyRef).onDestroy(context.provide('page', 'inventory'));
  effect((onCleanup) => {
    onCleanup(context.provide('page.kind', page.kind()));
  });

  const base = { category, when: here } as const;
  const defs: readonly CommandDefinition[] = [
    {
      ...base,
      id: 'inventory.focus-filter',
      title: text(scope, 'explorer.commands.focusFilter'),
      keybinding: EXPLORER_DEFAULT_CHORDS,
      unavailable: () => (page.hasList() ? null : noList()),
      run: () => {
        page.focusFilter();
      },
    },
    {
      ...base,
      id: 'inventory.reload',
      title: text(scope, 'explorer.commands.reload'),
      unavailable: () => (page.hasList() ? null : noList()),
      run: () => {
        page.reload();
      },
    },
    {
      ...base,
      id: 'inventory.save-view',
      title: text(scope, 'explorer.commands.saveView'),
      action: 'views.create',
      run: () => {
        page.saveView();
      },
    },
    {
      ...base,
      id: 'inventory.columns',
      title: text(scope, 'explorer.commands.columns'),
      unavailable: () => (page.hasGrid() ? null : noGrid()),
      run: () => {
        page.chooseColumns();
      },
    },
    {
      ...base,
      id: 'inventory.copy',
      title: text(scope, 'explorer.commands.copy'),
      unavailable: () => {
        if (!page.hasGrid()) return noGrid();
        return page.hasSelection() ? null : noSelection();
      },
      run: () => page.copy(),
    },
  ];
  registerCommands(defs);
}

export interface OverviewPageCommands {
  /** Refresh is closed (a read was made less than the floor ago, or one is running). */
  refreshClosed(): boolean;
  refresh(): void;
}

/** Registers the refresh command of the overview page. Call it in the page's injection context. */
export function registerOverviewCommands(page: OverviewPageCommands): void {
  const scope = explorerScope();
  const context = inject(CommandContext);
  const why = text(scope, 'explorer.overview.refreshWhy');
  inject(DestroyRef).onDestroy(context.provide('page', 'overview'));
  registerCommands([
    {
      id: OVERVIEW_COMMAND_ID,
      title: text(scope, 'explorer.commands.refresh'),
      category: text(scope, 'explorer.commands.category'),
      when: (get) => get('page') === 'overview',
      unavailable: () => (page.refreshClosed() ? why() : null),
      run: () => {
        page.refresh();
      },
    },
  ]);
}
