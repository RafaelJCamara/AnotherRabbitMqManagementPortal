// The page of one inventory kind (M0-54): a banner that says what the list is (freshness, live
// updates) above the grid, over a window source that reads `inventory.query` in blocks and follows
// the rows on screen. It reads the inventory only: no message, and no action that changes the broker.
import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  output,
  signal,
} from '@angular/core';
import {
  createInventoryWindowSource,
  type ExplorerFilter,
  type ExplorerKind,
  type ExplorerViewDefinition,
  type InventoryRow,
  type InventoryWindowSource,
  type WindowSourceState,
} from '@app/explorer-model';
import {
  DataGrid,
  GRID_CLIPBOARD,
  type GridCellTarget,
  type GridColumn,
  type GridColumnState,
  type GridLabels,
  type GridMenuProvider,
} from '@app/ui-grid';
import { TranslocoDirective } from '@jsverse/transloco';

import { EXPLORER_CONNECTION } from '../connection';
import { EXPLORER_DATA } from '../data/explorer-data';
import type { Translate } from '../translate';
import { inventoryColumns } from './columns';
import { FilterBar } from './filter-bar.component';
import { activeFilter, filterChips } from './filter-model';
import { FreshnessBanner } from './freshness-banner.component';
import { gridLabels } from './grid-labels';
import { absoluteAddress, EXPLORER_NAVIGATION, rowLabel } from '../navigation';
import { ProbePrompt } from '../profile/probe-prompt.component';
import { ProfileStore } from '../profile/profile-store';
import {
  ViewsControl,
  type ViewApplied,
} from '../views/views-control.component';
import { ViewsStore } from '../views/views-store';

interface Bundle {
  readonly t: Translate;
  readonly kind: ExplorerKind;
  readonly columns: GridColumn<InventoryRow>[];
  readonly labels: GridLabels;
  readonly menu: GridMenuProvider<InventoryRow>;
}

@Component({
  selector: 'app-inventory-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DataGrid,
    FilterBar,
    FreshnessBanner,
    ProbePrompt,
    TranslocoDirective,
    ViewsControl,
  ],
  providers: [ProfileStore, ViewsStore],
  template: `
    <ng-container *transloco="let t">
      @if (connection(); as cid) {
        <section class="page">
          <header class="head">
            <h1>{{ t(titleKey()) }}</h1>
            @if (counts(); as counts) {
              <p class="counts">
                {{ t('explorer.counts', counts) }}
              </p>
            }
            <app-views-control
              [kind]="kind()"
              [current]="current()"
              [viewId]="viewId()"
              (applied)="onViewApplied($event)"
            />
          </header>
          @if (needsProbe(); as need) {
            <!-- A first run: nobody has probed this connection, so the engine has no profile and cannot answer
                 a read of the inventory. Say so and offer the one button that fixes it. -->
            <section class="not-probed" aria-labelledby="not-probed-title">
              <h2 id="not-probed-title">{{ t('explorer.probe.title') }}</h2>
              <app-probe-prompt [need]="need" />
            </section>
          } @else {
            <app-filter-bar
              [kind]="kind()"
              [filter]="userFilter()"
              [vhost]="vhost()"
              (filterChange)="userFilter.set($event)"
              (vhostChange)="vhostChange.emit($event)"
            />
            <app-freshness-banner
              [kind]="kind()"
              [freshness]="state()?.freshness ?? null"
              [state]="state()"
            />
            @if (emptyBroker()) {
              <p class="notice empty" role="status">
                {{ emptyText(t) }}
              </p>
            }
            @if (noMatch()) {
              <p class="notice no-match" role="status">
                {{ noMatchText(t) }}
              </p>
            }
            @if (linkNotice(); as notice) {
              <p class="notice" role="status">
                {{
                  t(
                    notice === 'copied'
                      ? 'explorer.entity.linkCopied'
                      : 'explorer.entity.linkCopyFailed'
                  )
                }}
              </p>
            }
            @if (sortTrimmed()) {
              <p class="notice" role="status">
                {{ t('explorer.sort.trimmed') }}
              </p>
            }
            @if (source(); as source) {
              <div class="grid">
                <app-data-grid
                  [columns]="bundle(t).columns"
                  [source]="source"
                  [labels]="bundle(t).labels"
                  selectionMode="multiple"
                  sortMode="single"
                  [contextMenu]="bundle(t).menu"
                  [(columnState)]="columnState"
                  (sortTrimmed)="sortTrimmed.set(true)"
                  (rowActivated)="onActivated($event.row)"
                  (menuAction)="onMenu($event)"
                />
              </div>
            } @else if (profileLoading()) {
              <p class="notice" role="status">
                {{ t('explorer.capabilities.loading') }}
              </p>
            } @else if (viewPending()) {
              <p class="notice" role="status">
                {{ t('explorer.views.loading') }}
              </p>
            } @else if (needsVhost()) {
              <p class="notice">{{ t('explorer.bindings.needVhost') }}</p>
            }
          }
        </section>
      }
    </ng-container>
  `,
  styles: `
    :host {
      display: block;
      height: 100%;
      min-height: 0;
    }
    .page {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
    }
    .head {
      display: flex;
      align-items: baseline;
      gap: var(--ds-space-3);
      padding: var(--ds-space-2) var(--ds-space-3);
    }
    h1 {
      margin: 0;
      font-size: var(--ds-font-size-lg, 1.25em);
    }
    .counts,
    .notice {
      margin: 0;
      padding: var(--ds-space-1) var(--ds-space-3);
      color: var(--ds-color-text-muted);
    }
    .head .counts {
      padding: 0;
    }
    .grid {
      flex: 1 1 auto;
      min-height: 0;
    }
    .not-probed {
      padding: var(--ds-space-2) var(--ds-space-3);
    }
    .not-probed h2 {
      margin: 0 0 var(--ds-space-2);
      font-size: var(--ds-font-size-lg, 1.25em);
    }
  `,
})
export class InventoryPage {
  readonly kind = input.required<ExplorerKind>();
  /** The vhost of a bindings page: the engine reads bindings of exactly one vhost. */
  readonly vhost = input<string | null>(null);

  protected readonly connection = inject(EXPLORER_CONNECTION);
  readonly #data = inject(EXPLORER_DATA);
  readonly #navigation = inject(EXPLORER_NAVIGATION);
  readonly #clipboard = inject(GRID_CLIPBOARD);
  readonly #document = inject(DOCUMENT);
  /** What the last Copy link did, until the next row is opened or copied. */
  protected readonly linkNotice = signal<'copied' | 'failed' | null>(null);

  /** Chosen on the page: the name text and the facets (a bindings page chooses its vhost apart). */
  protected readonly userFilter = linkedSignal<ExplorerKind, ExplorerFilter>({
    source: this.kind,
    computation: () => ({}),
  });
  /** A bindings page was asked to open another vhost (the route puts it in `?vhost=`). */
  readonly vhostChange = output<string>();
  /** The saved view named in the address (`?view=`); the page reads nothing until it is applied. */
  readonly viewId = input<string | null>(null);
  /** A view was applied (or the address's view could not be): the route keeps it in `?view=`. */
  readonly viewChange = output<string | null>();

  #appliedView: string | null = null;
  /** A view in the address is applied before the first read, so the first query is the view's own. */
  protected readonly viewPending = linkedSignal<string | null, boolean>({
    source: this.viewId,
    computation: (id) => id !== null && id !== this.#appliedView,
  });

  /** What the engine is asked: the chosen filter, and for bindings the one vhost it requires. */
  protected readonly filter = computed<ExplorerFilter>(() => {
    const vhost = this.vhost();
    const chosen = this.userFilter();
    return this.kind() === 'bindings' && vhost !== null && vhost !== ''
      ? { ...chosen, vhosts: [vhost] }
      : chosen;
  });

  readonly #profile = inject(ProfileStore);
  /** The engine has no usable profile of the connection: nothing is read until the probe has run. */
  protected readonly needsProbe = this.#profile.needsProbe;
  protected readonly profileLoading = computed(
    () => this.#profile.state().status === 'loading',
  );
  /** A bindings page is waiting for the one vhost it needs. */
  protected readonly needsVhost = computed(
    () => this.kind() === 'bindings' && this.filter().vhosts?.length !== 1,
  );

  /**
   * One source is one query: a new kind, connection or filter is a new source. None is made while the profile
   * is being read (a read before the first probe can only fail) or while the connection needs the probe.
   */
  protected readonly source =
    computed<InventoryWindowSource<ExplorerKind> | null>(() => {
      const cid = this.connection();
      const kind = this.kind();
      const filter = this.filter();
      if (cid === null || this.viewPending()) return null;
      if (this.profileLoading() || this.needsProbe() !== null) return null;
      if (kind === 'bindings' && filter.vhosts?.length !== 1) return null;
      return createInventoryWindowSource<ExplorerKind>(this.#data, {
        cid,
        kind,
        filter,
      });
    });
  protected readonly state = signal<WindowSourceState | null>(null);
  protected readonly sortTrimmed = signal(false);
  /** The column state is per kind: another kind starts from its own defaults. */
  protected readonly columnState = linkedSignal<
    ExplorerKind,
    GridColumnState | null
  >({ source: this.kind, computation: () => null });

  protected readonly titleKey = computed(() => `explorer.kinds.${this.kind()}`);
  /** Rows after the filter, and the rows of the kind in the index: the engine's numbers. */
  protected readonly counts = computed(() => {
    const state = this.state();
    const matched = state?.matched ?? null;
    const total = state?.freshness?.loaded ?? null;
    return matched === null || total === null ? null : { matched, total };
  });

  /** What a save would store: the filter and the columns in force. */
  protected readonly current = computed<ExplorerViewDefinition>(() => ({
    version: 1,
    kind: this.kind(),
    filter: this.filter(),
    columns: this.columnState() ?? { version: 1, columns: [], sort: [] },
  }));

  /** A filter is active and the engine says nothing matches it (never while the first read is running). */
  protected readonly noMatch = computed(() => {
    const state = this.state();
    return (
      state?.matched === 0 &&
      state.freshness?.state !== 'loading' &&
      activeFilter(this.kind(), this.userFilter())
    );
  });

  /**
   * The engine read the whole list and the broker has none of this kind (no filter is active): said in words,
   * never left as a blank grid. Only an answer that is live and complete says it; a list still loading or one
   * that failed says that instead.
   */
  protected readonly emptyBroker = computed(() => {
    const state = this.state();
    const freshness = state?.freshness ?? null;
    if (state === null || freshness === null) return false;
    return (
      freshness.state === 'live' &&
      freshness.complete &&
      freshness.loaded === 0 &&
      state.matched === 0 &&
      !activeFilter(this.kind(), this.userFilter())
    );
  });

  #bundle: Bundle | null = null;

  constructor() {
    effect((onCleanup) => {
      const source = this.source();
      if (source === null) {
        this.state.set(null);
        return;
      }
      this.state.set(source.state());
      const stop = source.onState((next) => {
        this.state.set(next);
      });
      onCleanup(() => {
        stop();
        source.destroy(); // aborts what is in flight and ends the subscription
      });
    });
  }

  /** Applies what a view says that this kind can take; what it cannot is the control's to list. */
  protected onViewApplied(event: ViewApplied): void {
    this.#appliedView = event.id;
    const parsed = event.parsed;
    if (parsed !== null && !parsed.appliesNothing) {
      const { filter, columns } = parsed.definition;
      if (this.kind() === 'bindings') {
        const { vhosts, ...rest } = filter;
        this.userFilter.set(rest);
        const [vhost] = vhosts ?? [];
        if (vhost !== undefined) this.vhostChange.emit(vhost);
      } else {
        this.userFilter.set(filter);
      }
      this.columnState.set(
        columns.columns.length === 0 && columns.sort.length === 0
          ? null
          : columns,
      );
    }
    this.viewPending.set(false);
    this.viewChange.emit(event.id);
  }

  /** A row was activated (Enter or a double click) or "Open details" was chosen: open its entity. */
  protected onActivated(row: InventoryRow): void {
    const cid = this.connection();
    if (cid === null) return;
    this.linkNotice.set(null);
    this.#navigation.open(
      cid,
      { kind: this.kind(), key: row.key },
      rowLabel(row),
    );
  }

  /** A choice of the row menu: open the entity, or copy its address. */
  protected onMenu(event: {
    readonly itemId: string;
    readonly target: GridCellTarget<InventoryRow>;
  }): void {
    const row = event.target.row;
    if (row === undefined) return;
    if (event.itemId === 'open') this.onActivated(row);
    else if (event.itemId === 'copyLink') void this.#copyLink(row);
  }

  async #copyLink(row: InventoryRow): Promise<void> {
    const cid = this.connection();
    if (cid === null) return;
    const path = this.#navigation.href(cid, {
      kind: this.kind(),
      key: row.key,
    });
    try {
      await this.#clipboard.writeText(absoluteAddress(this.#document, path));
      this.linkNotice.set('copied');
    } catch {
      this.linkNotice.set('failed');
    }
  }

  /** "This broker has no queues", per kind. */
  protected emptyText(t: Translate): string {
    return t(`explorer.empty.${this.kind()}`);
  }

  /** "No rows match", with the chips that could be the cause. */
  protected noMatchText(t: Translate): string {
    const filters = filterChips(this.kind(), this.userFilter(), t)
      .map((chip) => chip.text)
      .join(', ');
    return t('explorer.filters.noMatch', { filters });
  }

  /** The columns and labels for the translate function in force; rebuilt only when it or the kind changes. */
  protected bundle(t: Translate): Bundle {
    const kind = this.kind();
    if (this.#bundle?.t !== t || this.#bundle.kind !== kind) {
      this.#bundle = {
        t,
        kind,
        columns: inventoryColumns(kind, t),
        labels: gridLabels(kind, t),
        menu: (target) =>
          target.row === undefined
            ? []
            : [
                {
                  kind: 'plain',
                  id: 'open',
                  label: t('explorer.entity.menu.open'),
                },
                {
                  kind: 'plain',
                  id: 'copyLink',
                  label: t('explorer.entity.menu.copyLink'),
                },
              ],
      };
    }
    return this.#bundle;
  }
}
