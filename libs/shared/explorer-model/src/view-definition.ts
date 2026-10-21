// A saved view of an explorer grid (M0-54, R8, Q-12, Q-14): the filter and the column state of one
// kind, stored as the `definition` of `views.create`. A stored definition is somebody's old data, so
// reading it never throws and never applies what does not fit: it drops what the kind or this build
// cannot apply, and says what it dropped, so the page lists every drop (I-13).
import { VIEW_DEFINITION_MAX_CHARS } from '@app/contracts';

import {
  COLUMNS_BY_KIND,
  EXPLORER_KINDS,
  FILTER_CAPS,
  facetApplies,
  isFilterEmpty,
  type ExplorerFilter,
  type FacetName,
} from './inventory-model';
import type { ExplorerKind } from './ports';

/** The shape of `GridColumnState` of `ui-grid` as plain JSON (this library cannot import the grid). */
export interface ColumnStateJson {
  readonly version: 1;
  readonly columns: readonly ColumnEntryJson[];
  readonly sort: readonly {
    readonly columnId: string;
    readonly direction: 'asc' | 'desc';
  }[];
}

export interface ColumnEntryJson {
  readonly id: string;
  readonly hidden?: boolean;
  readonly width?: number;
  readonly pinned?: 'left' | 'right' | null;
}

export interface ExplorerViewDefinition {
  readonly version: 1;
  readonly kind: ExplorerKind;
  readonly filter: ExplorerFilter;
  readonly columns: ColumnStateJson;
}

export type ViewDrop =
  | 'newer-version'
  | 'wrong-kind'
  | 'filter-not-for-kind'
  | 'unknown-column'
  | 'filter-over-cap'
  | 'invalid';

export interface ViewDropped {
  readonly what: ViewDrop;
  /** The facet, column or key concerned. */
  readonly detail?: string;
}

export interface ParsedView {
  readonly definition: ExplorerViewDefinition;
  readonly dropped: readonly ViewDropped[];
  /** Nothing of the stored definition applies: the grid keeps its defaults. */
  readonly appliesNothing: boolean;
}

const EMPTY_COLUMNS: ColumnStateJson = { version: 1, columns: [], sort: [] };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const FILTER_KEYS: readonly (keyof ExplorerFilter)[] = [
  'text',
  'vhosts',
  'types',
  'states',
  'hasConsumers',
  'minMessages',
];

/** A list facet: strings only, cut at the cap (the cut is reported), duplicates dropped. */
function listFacet(
  raw: unknown,
  facet: 'vhosts' | 'types' | 'states',
  dropped: ViewDropped[],
): string[] | undefined {
  if (!Array.isArray(raw)) {
    dropped.push({ what: 'invalid', detail: facet });
    return undefined;
  }
  const cap = facet === 'vhosts' ? FILTER_CAPS.vhostChips : FILTER_CAPS[facet];
  const values: string[] = [];
  for (const value of raw as unknown[]) {
    if (typeof value !== 'string' || value === '') {
      dropped.push({ what: 'invalid', detail: facet });
    } else if (!values.includes(value)) {
      values.push(value);
    }
  }
  if (values.length > cap) {
    dropped.push({ what: 'filter-over-cap', detail: facet });
    values.length = cap;
  }
  return values.length > 0 ? values : undefined;
}

function parseFilter(
  raw: unknown,
  kind: ExplorerKind,
  dropped: ViewDropped[],
): ExplorerFilter {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    dropped.push({ what: 'invalid', detail: 'filter' });
    return {};
  }
  const filter: ExplorerFilter = {};
  for (const key of Object.keys(raw)) {
    if (!FILTER_KEYS.includes(key as keyof ExplorerFilter)) {
      dropped.push({ what: 'invalid', detail: key });
      continue;
    }
    if (key !== 'text' && !facetApplies(kind, key as FacetName)) {
      dropped.push({ what: 'filter-not-for-kind', detail: key });
      continue;
    }
    const value = raw[key];
    switch (key) {
      case 'text':
        if (typeof value !== 'string')
          dropped.push({ what: 'invalid', detail: key });
        else if (value.length > FILTER_CAPS.text)
          dropped.push({ what: 'filter-over-cap', detail: key });
        else if (value !== '') filter.text = value;
        break;
      case 'vhosts':
      case 'types':
      case 'states': {
        const values = listFacet(value, key, dropped);
        if (values) filter[key] = values;
        break;
      }
      case 'hasConsumers':
        if (typeof value === 'boolean') filter.hasConsumers = value;
        else dropped.push({ what: 'invalid', detail: key });
        break;
      case 'minMessages':
        if (typeof value === 'number' && Number.isInteger(value) && value >= 0)
          filter.minMessages = value;
        else dropped.push({ what: 'invalid', detail: key });
        break;
    }
  }
  return filter;
}

function parseColumns(
  raw: unknown,
  kind: ExplorerKind,
  dropped: ViewDropped[],
): ColumnStateJson {
  if (raw === undefined) return EMPTY_COLUMNS;
  if (!isRecord(raw) || raw.version !== 1) {
    dropped.push({ what: 'invalid', detail: 'columns' });
    return EMPTY_COLUMNS;
  }
  const known = new Map(COLUMNS_BY_KIND[kind].map((c) => [c.id, c]));
  const columns: ColumnEntryJson[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw.columns)
    ? (raw.columns as unknown[])
    : []) {
    if (!isRecord(item) || typeof item.id !== 'string') {
      dropped.push({ what: 'invalid', detail: 'columns' });
      continue;
    }
    const id = item.id;
    if (!known.has(id)) {
      dropped.push({ what: 'unknown-column', detail: id });
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    const width = item.width;
    const pinned = item.pinned;
    columns.push({
      id,
      ...(typeof item.hidden === 'boolean' ? { hidden: item.hidden } : {}),
      ...(typeof width === 'number' && Number.isFinite(width) ? { width } : {}),
      ...(pinned === 'left' || pinned === 'right' || pinned === null
        ? { pinned }
        : {}),
    });
  }
  const sort: { columnId: string; direction: 'asc' | 'desc' }[] = [];
  for (const entry of Array.isArray(raw.sort) ? (raw.sort as unknown[]) : []) {
    if (!isRecord(entry) || typeof entry.columnId !== 'string') {
      dropped.push({ what: 'invalid', detail: 'sort' });
      continue;
    }
    const { columnId, direction } = entry as {
      columnId: string;
      direction: unknown;
    };
    if (known.get(columnId)?.sortable !== true) {
      dropped.push({ what: 'unknown-column', detail: columnId });
    } else if (direction !== 'asc' && direction !== 'desc') {
      dropped.push({ what: 'invalid', detail: 'sort' });
    } else if (sort.length > 0) {
      dropped.push({ what: 'invalid', detail: 'sort' }); // the engine sorts by one column
    } else {
      sort.push({ columnId, direction });
    }
  }
  return { version: 1, columns, sort };
}

/**
 * Reads a stored definition for a grid of `kind`. It never throws. A definition of a newer version or
 * of another kind applies nothing; inside a readable one every part that does not fit is dropped and
 * reported: facets that do not apply to the kind, columns this kind does not have, values over a cap.
 */
export function parseViewDefinition(
  raw: unknown,
  kind: ExplorerKind,
): ParsedView {
  const nothing = (what: ViewDrop, detail?: string): ParsedView => ({
    definition: { version: 1, kind, filter: {}, columns: EMPTY_COLUMNS },
    dropped: [{ what, ...(detail === undefined ? {} : { detail }) }],
    appliesNothing: true,
  });
  if (!isRecord(raw)) return nothing('invalid');
  const version = raw.version;
  if (typeof version === 'number' && version > 1)
    return nothing('newer-version');
  if (version !== 1) return nothing('invalid', 'version');
  const stored = raw.kind;
  if (typeof stored !== 'string' || !EXPLORER_KINDS.some((k) => k === stored)) {
    return nothing('invalid', 'kind');
  }
  if (stored !== kind) return nothing('wrong-kind', stored);

  const dropped: ViewDropped[] = [];
  const filter = parseFilter(raw.filter, kind, dropped);
  const columns = parseColumns(raw.columns, kind, dropped);
  const appliesNothing =
    isFilterEmpty(filter) &&
    columns.columns.length === 0 &&
    columns.sort.length === 0;
  return {
    definition: { version: 1, kind, filter, columns },
    dropped,
    appliesNothing,
  };
}

export type SerializedView =
  | { readonly ok: true; readonly definition: Record<string, unknown> }
  | { readonly ok: false; readonly reason: 'too-large' };

/** The definition as `views.create` takes it, refused here when its JSON text is over the contract's limit. */
export function serializeView(
  definition: ExplorerViewDefinition,
): SerializedView {
  const plain = JSON.parse(JSON.stringify(definition)) as Record<
    string,
    unknown
  >;
  return JSON.stringify(plain).length > VIEW_DEFINITION_MAX_CHARS
    ? { ok: false, reason: 'too-large' }
    : { ok: true, definition: plain };
}
