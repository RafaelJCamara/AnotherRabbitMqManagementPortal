// The page of one inventory kind (M0-54): a banner that says what the list is (freshness, live
// updates) above the grid, over a window source that reads `inventory.query` in blocks and follows
// the rows on screen. It reads the inventory only: no message, and no action that changes the broker.
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
  type InventoryRow,
  type InventoryWindowSource,
  type WindowSourceState,
} from '@app/explorer-model';
import {
  DataGrid,
  type GridColumn,
  type GridColumnState,
  type GridLabels,
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

interface Bundle {
  readonly t: Translate;
  readonly kind: ExplorerKind;
  readonly columns: GridColumn<InventoryRow>[];
  readonly labels: GridLabels;
}

@Component({
  selector: 'app-inventory-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DataGrid, FilterBar, FreshnessBanner, TranslocoDirective],
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
          </header>
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
          @if (noMatch()) {
            <p class="notice no-match" role="status">
              {{ noMatchText(t) }}
            </p>
          }
          @if (sortTrimmed()) {
            <p class="notice" role="status">{{ t('explorer.sort.trimmed') }}</p>
          }
          @if (source(); as source) {
            <div class="grid">
              <app-data-grid
                [columns]="bundle(t).columns"
                [source]="source"
                [labels]="bundle(t).labels"
                selectionMode="multiple"
                sortMode="single"
                [(columnState)]="columnState"
                (sortTrimmed)="sortTrimmed.set(true)"
              />
            </div>
          } @else {
            <p class="notice">{{ t('explorer.bindings.needVhost') }}</p>
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
  `,
})
export class InventoryPage {
  readonly kind = input.required<ExplorerKind>();
  /** The vhost of a bindings page: the engine reads bindings of exactly one vhost. */
  readonly vhost = input<string | null>(null);

  protected readonly connection = inject(EXPLORER_CONNECTION);
  readonly #data = inject(EXPLORER_DATA);

  /** Chosen on the page: the name text and the facets (a bindings page chooses its vhost apart). */
  protected readonly userFilter = linkedSignal<ExplorerKind, ExplorerFilter>({
    source: this.kind,
    computation: () => ({}),
  });
  /** A bindings page was asked to open another vhost (the route puts it in `?vhost=`). */
  readonly vhostChange = output<string>();

  /** What the engine is asked: the chosen filter, and for bindings the one vhost it requires. */
  protected readonly filter = computed<ExplorerFilter>(() => {
    const vhost = this.vhost();
    const chosen = this.userFilter();
    return this.kind() === 'bindings' && vhost !== null && vhost !== ''
      ? { ...chosen, vhosts: [vhost] }
      : chosen;
  });

  /** One source is one query: a new kind, connection or filter is a new source. */
  protected readonly source =
    computed<InventoryWindowSource<ExplorerKind> | null>(() => {
      const cid = this.connection();
      const kind = this.kind();
      const filter = this.filter();
      if (cid === null) return null;
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

  /** A filter is active and the engine says nothing matches it (never while the first read is running). */
  protected readonly noMatch = computed(() => {
    const state = this.state();
    return (
      state?.matched === 0 &&
      state.freshness?.state !== 'loading' &&
      activeFilter(this.kind(), this.userFilter())
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
      };
    }
    return this.#bundle;
  }
}
