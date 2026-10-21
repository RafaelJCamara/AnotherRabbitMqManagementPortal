// What the explorer knows about the four inventory kinds: their columns (R7), which filter facets
// apply to which kind (R5) and the caps. It is data and small functions; it never reads a row.
import {
  FILTER_TEXT_MAX,
  INVENTORY_KINDS,
  VISIBLE_KEYS_MAX,
  WINDOW_LIMIT_DEFAULT,
} from '@app/contracts';

import type { ExplorerKind } from './ports';

export const EXPLORER_KINDS: readonly ExplorerKind[] = INVENTORY_KINDS;

/** One grid block: the grid asks offsets that are multiples of this and limits of at most this. */
export const WINDOW_BLOCK = WINDOW_LIMIT_DEFAULT;
/** The most keys one subscription names (the contract's). */
export const SUB_KEYS_MAX = VISIBLE_KEYS_MAX;

/** A change of the filter text applies after this long without typing, or at once on Enter. */
export const FILTER_DEBOUNCE_MS = 200;

/** The caps of the contract, and the explorer's own cap on vhost chips (a saved view stays small). */
export const FILTER_CAPS = {
  text: FILTER_TEXT_MAX,
  vhosts: 100,
  types: 16,
  states: 16,
  /** The explorer's own: 25 vhost chips keep a view definition inside 16,384 characters. */
  vhostChips: 25,
} as const;

/** The filter of the contract, nothing more: no pattern syntax, no client-side filtering (R5). */
export interface ExplorerFilter {
  text?: string;
  vhosts?: string[];
  types?: string[];
  states?: string[];
  hasConsumers?: boolean;
  minMessages?: number;
}

export type FacetName = Exclude<keyof ExplorerFilter, 'text'>;

/** Which facets (besides the text, which every kind has) the engine applies to each kind. */
export const FACETS_BY_KIND: Readonly<
  Record<ExplorerKind, readonly FacetName[]>
> = {
  queues: ['vhosts', 'types', 'states', 'hasConsumers', 'minMessages'],
  exchanges: ['vhosts', 'types'],
  connections: ['vhosts', 'types', 'states'],
  bindings: ['vhosts'],
};

export function facetApplies(kind: ExplorerKind, facet: FacetName): boolean {
  return FACETS_BY_KIND[kind].includes(facet);
}

/**
 * The filter as it may be sent for `kind`: only the facets that apply to it (the engine matches a
 * facet that does not apply against nothing, so sending one would empty the grid), and nothing
 * empty. The text and the values are sent as typed.
 */
export function sanitizeFilter(
  kind: ExplorerKind,
  filter: ExplorerFilter,
): ExplorerFilter {
  const out: ExplorerFilter = {};
  if (filter.text !== undefined && filter.text !== '') out.text = filter.text;
  if (facetApplies(kind, 'vhosts') && filter.vhosts?.length)
    out.vhosts = [...filter.vhosts];
  if (facetApplies(kind, 'types') && filter.types?.length)
    out.types = [...filter.types];
  if (facetApplies(kind, 'states') && filter.states?.length)
    out.states = [...filter.states];
  if (facetApplies(kind, 'hasConsumers') && filter.hasConsumers !== undefined)
    out.hasConsumers = filter.hasConsumers;
  if (facetApplies(kind, 'minMessages') && filter.minMessages !== undefined)
    out.minMessages = filter.minMessages;
  return out;
}

export function isFilterEmpty(filter: ExplorerFilter): boolean {
  return Object.keys(filter).length === 0;
}

// ---- Columns (R7) --------------------------------------------------------------------------------

export interface ColumnSpec {
  /** The engine's column name, so a grid sort column id is an `InventorySort.column`. */
  readonly id: string;
  readonly hiddenByDefault: boolean;
  /** Whether the engine accepts a sort by this column. */
  readonly sortable: boolean;
}

const shown = (id: string, sortable = true): ColumnSpec => ({
  id,
  hiddenByDefault: false,
  sortable,
});
const hidden = (id: string, sortable = true): ColumnSpec => ({
  id,
  hiddenByDefault: true,
  sortable,
});

/** Every column of each kind in display order, with its default visibility and whether it sorts. */
export const COLUMNS_BY_KIND: Readonly<
  Record<ExplorerKind, readonly ColumnSpec[]>
> = {
  queues: [
    shown('name'),
    shown('vhost'),
    shown('type'),
    shown('state'),
    shown('messagesReady'),
    shown('messagesUnacknowledged'),
    shown('messages'),
    shown('consumers'),
    shown('policy'),
    hidden('node'),
    hidden('durable'),
    hidden('autoDelete'),
    hidden('exclusive'),
    hidden('operatorPolicy'),
    hidden('deliveryLimit'),
  ],
  exchanges: [
    shown('name'),
    shown('vhost'),
    shown('type'),
    shown('durable'),
    shown('autoDelete'),
    shown('internal'),
  ],
  connections: [
    shown('name'),
    shown('vhost'),
    shown('user'),
    shown('node'),
    shown('state'),
    shown('protocol'),
    shown('channels'),
    shown('peerHost'),
    shown('ssl'),
  ],
  bindings: [
    shown('source'),
    shown('destination'),
    shown('destinationType'),
    shown('routingKey'),
    hidden('vhost'),
    hidden('propertiesKey', false),
    hidden('argumentsKey', false),
    hidden('argumentsTruncated', false),
  ],
};

export function sortableColumns(kind: ExplorerKind): readonly string[] {
  return COLUMNS_BY_KIND[kind].filter((c) => c.sortable).map((c) => c.id);
}

export function isSortable(kind: ExplorerKind, column: string): boolean {
  return COLUMNS_BY_KIND[kind].some((c) => c.id === column && c.sortable);
}
