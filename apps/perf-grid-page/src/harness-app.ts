// The root of the harness page: `<app-data-grid>` on a fake engine window of 100,000 rows, plus the hooks the
// Node driver reads through `Runtime.evaluate` (`window.__grid`). The grid, its datasource, the theme bridge and
// the context menu are the real ones; the "engine" is `createFakeWindowSource` answering after a short delay.
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
} from '@angular/core';
import {
  DataGrid,
  GRID_BLOCK_SIZE,
  GRID_MAX_BLOCKS,
  type GridColumn,
  type GridLabels,
  type GridMenuItem,
} from '@app/ui-grid';
import { createFakeWindowSource, type FakeRow } from '@app/ui-grid/testing';
import { gridApiOf } from '@app/ui-grid/testing/components';
import {
  ThemeService,
  type Density,
  type ThemePreference,
} from '@app/ui-design';

import {
  ANSWER_LATENCY_MS,
  ROWS,
  type PageState,
  type PolicyState,
} from './contract';

const LABELS: GridLabels = {
  gridLabel: 'Queues',
  loading: 'Loading',
  noRows: 'Nothing here',
  menu: {
    label: 'Row actions',
    whyDisabled: 'Why disabled',
    degraded: 'Limited',
    source: 'Source',
    noReason: 'No reason given',
  },
  status: {
    total: '{count} rows',
    totalUnknown: 'Total not known yet',
    loaded: '{count} loaded',
    selected: '{count} selected',
    loading: 'Loading rows',
    error: 'Some rows could not be loaded',
    retry: 'Try again',
    copied: '{count} rows copied',
    copyTruncated: '{count} rows copied, {omitted} not copied',
    copyFailed: 'The clipboard did not accept the copy',
    selectionCapped: 'At most {count} rows can be selected',
    dropped: '{count} live changes were not applied',
  },
  columnChooser: {
    button: 'Columns',
    title: 'Choose columns',
    up: 'Up',
    down: 'Down',
    moveUp: 'Move {name} up',
    moveDown: 'Move {name} down',
    width: 'Width of {name}',
    reset: 'Reset columns',
    lastColumn: 'At least one column stays visible',
  },
};

const COLUMNS: readonly GridColumn<FakeRow>[] = [
  { id: 'name', header: 'Name', value: (row) => row.name, sortable: true },
  {
    id: 'index',
    header: 'Position',
    value: (row) => row.index,
    sortable: true,
    align: 'end',
  },
  {
    id: 'state',
    header: 'State',
    value: (row) => (row.index % 2 === 0 ? 'running' : 'idle'),
  },
  {
    id: 'messages',
    header: 'Messages',
    value: (row) => (row.index * 37) % 10_000,
    align: 'end',
  },
];

/** What `window.__grid` offers the driver. */
export interface HarnessHooks {
  state(): PageState;
  policy(): PolicyState;
  /** Starts recording the most blocks and rows the grid held (after every model update and every answer). */
  startSampling(): void;
  setTheme(preference: ThemePreference): void;
  setDensity(density: Density): void;
}

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DataGrid],
  template: `
    <app-data-grid
      [columns]="columns"
      [source]="source"
      [labels]="labels"
      selectionMode="multiple"
      [contextMenu]="menu"
    />
  `,
  styles: `
    :host {
      display: block;
      height: 100vh;
    }
  `,
})
export class HarnessApp {
  protected readonly columns = COLUMNS;
  protected readonly labels = LABELS;
  protected readonly menu = (): readonly GridMenuItem[] => [
    { kind: 'plain', id: 'open', label: 'Open' },
    { kind: 'separator' },
    { kind: 'plain', id: 'copy-name', label: 'Copy name' },
  ];

  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly theme = inject(ThemeService);

  private readonly fake = createFakeWindowSource({
    rows: ROWS,
    latencyMs: ANSWER_LATENCY_MS,
  });
  // Self-check knobs (the driver passes them through the query string, see the README): they make the page worse on
  // purpose, to show that each gate of the run can fail. Nothing here is set in a normal run.
  readonly #knobs = new URLSearchParams(window.location.search);
  readonly #jankMs = Number(this.#knobs.get('jank') ?? 0);
  readonly #leaked: unknown[] = [];
  #inflight = 0;
  #maxInflight = 0;
  #maxLimit = 0;
  #misaligned = 0;
  readonly #blockStarts = new Set<number>();
  #sampling = false;
  #maxBlocks = 0;
  #maxDomRows = 0;

  protected readonly source = {
    rowId: (row: FakeRow): string => this.fake.rowId(row),
    window: async (
      request: Parameters<typeof this.fake.window>[0],
      signal: AbortSignal,
    ) => {
      this.#inflight += 1;
      this.#maxInflight = Math.max(this.#maxInflight, this.#inflight);
      this.#maxLimit = Math.max(this.#maxLimit, request.limit);
      if (request.offset % GRID_BLOCK_SIZE !== 0) this.#misaligned += 1;
      this.#blockStarts.add(request.offset);
      try {
        const answer = await this.fake.window(request, signal);
        if (this.#knobs.has('leak')) this.#leaked.push(answer);
        if (this.#jankMs > 0) {
          const until = performance.now() + this.#jankMs;
          while (performance.now() < until) {
            // a main-thread task of `jank` ms in every answer
          }
        }
        return answer;
      } finally {
        this.#inflight -= 1;
        // After the grid has taken the answer (its callback runs in this turn's microtasks).
        setTimeout(() => {
          this.#sample();
        }, 0);
      }
    },
    refreshed: (): void => {
      this.fake.refreshed?.();
    },
  };

  constructor() {
    const hooks: HarnessHooks = {
      state: () => this.#state(),
      policy: () => this.#policy(),
      startSampling: () => {
        this.#sampling = true;
        this.#maxBlocks = 0;
        this.#maxDomRows = 0;
        gridApiOf(this.element.nativeElement).addEventListener(
          'modelUpdated',
          () => {
            this.#sample();
          },
        );
        this.#sample();
      },
      setTheme: (preference) => {
        this.theme.setPreference(preference);
      },
      setDensity: (density) => {
        this.theme.setDensity(density);
      },
    };
    (window as unknown as { __grid: HarnessHooks }).__grid = hooks;
    if (this.#knobs.has('violate')) {
      try {
        const script = document.createElement('script');
        script.textContent = 'window.__violated = true';
        document.head.appendChild(script);
      } catch {
        // Trusted Types refuses the assignment, which is itself reported.
      }
    }
  }

  #blocks(): number {
    // AG Grid types the state as `any`: one entry per block the infinite cache holds.
    const state = gridApiOf(
      this.element.nativeElement,
    ).getCacheBlockState() as unknown;
    return typeof state === 'object' && state !== null
      ? Object.keys(state).length
      : 0;
  }

  #domRows(): number {
    return this.element.nativeElement.querySelectorAll('.ag-row').length;
  }

  #sample(): void {
    if (!this.#sampling) return;
    this.#maxBlocks = Math.max(this.#maxBlocks, this.#blocks());
    this.#maxDomRows = Math.max(this.#maxDomRows, this.#domRows());
  }

  #viewport(): HTMLElement | null {
    return this.element.nativeElement.querySelector<HTMLElement>(
      '.ag-grid-viewport',
    );
  }

  #state(): PageState {
    const api = gridApiOf(this.element.nativeElement);
    const viewport = this.#viewport();
    const row =
      this.element.nativeElement.querySelector<HTMLElement>('.ag-row');
    return {
      rows: ROWS,
      answerLatencyMs: ANSWER_LATENCY_MS,
      blockSize: GRID_BLOCK_SIZE,
      blockLimit: GRID_MAX_BLOCKS,
      blocks: this.#blocks(),
      maxBlocks: this.#maxBlocks,
      requests: this.fake.requests.length,
      maxLimit: this.#maxLimit,
      maxInflight: this.#maxInflight,
      misaligned: this.#misaligned,
      distinctBlocks: this.#blockStarts.size,
      domRows: this.#domRows(),
      maxDomRows: this.#maxDomRows,
      rowCount: api.getDisplayedRowCount(),
      scrollTop: viewport?.scrollTop ?? 0,
      rowHeight: row === null ? 0 : row.getBoundingClientRect().height,
      viewportHeight: viewport?.clientHeight ?? 0,
    };
  }

  #policy(): PolicyState {
    const nonce =
      document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')
        ?.content ?? '';
    const styles = [...document.querySelectorAll('style')];
    const root =
      this.element.nativeElement.querySelector<HTMLElement>('.ag-root-wrapper');
    const row =
      this.element.nativeElement.querySelector<HTMLElement>('.ag-row');
    return {
      nonce,
      styleElements: styles.length,
      noncedStyleElements: styles.filter(
        (style) => nonce !== '' && style.nonce === nonce,
      ).length,
      gridRootStyleAttribute: root?.getAttribute('style') ?? null,
      theme: document.documentElement.getAttribute('data-theme'),
      density: document.documentElement.getAttribute('data-density'),
      gridBackground:
        root === null ? '' : getComputedStyle(root).backgroundColor,
      rowHeight: row === null ? 0 : row.getBoundingClientRect().height,
      menuOpen: document.querySelector('[role="menu"]') !== null,
    };
  }
}
