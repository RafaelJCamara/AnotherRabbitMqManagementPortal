// The ports of the explorer's plain logic (M0-54): how it reads the inventory and follows the rows on
// screen, and the structural window types the grid adapter accepts. This library imports no Angular
// and no grid; `feature-explorer` checks at compile time that these shapes stay assignable to
// `ui-grid`'s `EngineWindowSource`.
import type {
  explorerWindowTopic,
  InputOf,
  InventoryKind,
  inventoryQuery,
  ItemOf,
  OutputOf,
  ParamsOf,
} from '@app/contracts';

export type ExplorerKind = InventoryKind;
/** The kinds the live topic follows; `bindings` have no topic. */
export type FollowedKind = ExplorerWindowParams['kind'];

export type InventoryQueryInput = InputOf<typeof inventoryQuery>;
export type InventoryQueryOutput = OutputOf<typeof inventoryQuery>;
export type Freshness = InventoryQueryOutput['freshness'];

export type InventoryRows = {
  readonly [K in ExplorerKind]: Extract<
    InventoryQueryOutput,
    { kind: K }
  >['rows'][number];
};
export type InventoryRow<K extends ExplorerKind = ExplorerKind> =
  InventoryRows[K];

export type ExplorerWindowParams = ParamsOf<typeof explorerWindowTopic>;
export type ExplorerWindowItem = ItemOf<typeof explorerWindowTopic>;

/**
 * What the topic sends a follower. The engine-backed port maps the live client's events to these;
 * the model never sees rxjs. `error` and `end` end the topic.
 */
export type ExplorerLiveEvent =
  | { readonly kind: 'snapshot'; readonly items: readonly ExplorerWindowItem[] }
  | {
      readonly kind: 'delta';
      readonly upserts: readonly ExplorerWindowItem[];
      readonly removes: readonly string[];
    }
  | { readonly kind: 'gap' }
  | { readonly kind: 'status'; readonly state: string }
  | { readonly kind: 'reset' }
  | { readonly kind: 'error'; readonly error: unknown }
  /** The engine ended the subscription without a Problem. */
  | { readonly kind: 'end' };

/** How the explorer reads and follows the inventory of one connection. */
export interface ExplorerData {
  query(
    input: InventoryQueryInput,
    signal: AbortSignal,
  ): Promise<InventoryQueryOutput>;
  /** Starts a subscription to `explorer.window`; the returned function ends it. */
  follow(
    params: ExplorerWindowParams,
    listener: (event: ExplorerLiveEvent) => void,
  ): () => void;
}

// ---- The window types of `ui-grid`, as plain shapes ----------------------------------------------

export interface WindowSort {
  readonly columnId: string;
  readonly direction: 'asc' | 'desc';
}

export interface WindowRequest {
  readonly offset: number;
  readonly limit: number;
  readonly sort: readonly WindowSort[];
}

export interface WindowAnswer<Row> {
  readonly rows: readonly Row[];
  readonly total: number | null;
}

export type RowChange<Row> =
  | { readonly kind: 'upsert'; readonly row: Row }
  | { readonly kind: 'remove'; readonly rowId: string }
  | { readonly kind: 'refresh' };
