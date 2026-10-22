// Public API of this library. Export only what other projects need.
export {
  COLUMNS_BY_KIND,
  EXPLORER_KINDS,
  FACETS_BY_KIND,
  FILTER_CAPS,
  FILTER_DEBOUNCE_MS,
  SUB_KEYS_MAX,
  WINDOW_BLOCK,
  facetApplies,
  isFilterEmpty,
  isSortable,
  sanitizeFilter,
  sortableColumns,
  type ColumnSpec,
  type ExplorerFilter,
  type FacetName,
} from './inventory-model';
export type {
  ExplorerData,
  ExplorerKind,
  ExplorerLiveEvent,
  ExplorerWindowItem,
  ExplorerWindowParams,
  FollowedKind,
  Freshness,
  InventoryQueryInput,
  InventoryQueryOutput,
  InventoryRow,
  InventoryRows,
  RowChange,
  WindowAnswer,
  WindowRequest,
  WindowSort,
} from './ports';
export { SUB_KEYS_BYTES_MAX, fitKeys, type FittedKeys } from './key-budget';
export {
  createInventoryWindowSource,
  type InventoryQuery,
  type InventoryWindowSource,
  type WindowSourceCounters,
  type WindowSourceState,
} from './window-source';
export {
  DEFAULT_EXCHANGE_LABEL,
  bindingParts,
  entityLabel,
  entityPath,
  entityUrl,
  parseEntityPath,
  type EntityRef,
  type ParsedEntityAddress,
} from './entity-address';
export {
  ENTITY_TAB_IDS,
  resolveTab,
  tabSetFor,
  type EntityTabId,
  type EntityTabSpec,
} from './entity-tabs';
export {
  createEntityWatch,
  isCertain,
  lookupEntity,
  type EntityPhase,
  type EntityQuery,
  type EntityState,
  type EntityWatch,
} from './entity-watch';
export {
  RELATED_SCAN_MAX,
  RELATED_SHOWN_MAX,
  loadRelatedBindings,
  type BindingRow,
  type BindingScan,
  type BindingScanQuery,
  type RelatedBindings,
} from './related-bindings';
export {
  parseViewDefinition,
  serializeView,
  type ColumnEntryJson,
  type ColumnStateJson,
  type ExplorerViewDefinition,
  type ParsedView,
  type SerializedView,
  type ViewDrop,
  type ViewDropped,
} from './view-definition';
