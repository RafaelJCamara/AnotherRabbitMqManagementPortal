import { COLUMN_MIN_WIDTH, type ResolvedColumn } from './columns';
import type { GridSort } from './window-source';

/** Plain, versioned JSON: what a view stores (M0-54). Array order is the display order. */
export interface GridColumnState {
  readonly version: 1;
  readonly columns: readonly GridColumnEntry[];
  readonly sort: readonly GridSort[];
}

export interface GridColumnEntry {
  readonly id: string;
  readonly hidden?: boolean;
  readonly width?: number;
  readonly pinned?: 'left' | 'right' | null;
}

export const COLUMN_MAX_WIDTH = 1200;

export function defaultColumnState<Row>(
  columns: readonly ResolvedColumn<Row>[],
): GridColumnState {
  return {
    version: 1,
    columns: columns.map((c) => ({
      id: c.id,
      hidden: c.hidden,
      width: c.width,
      pinned: null,
    })),
    sort: [],
  };
}

/**
 * Makes any stored value safe to apply: unknown and duplicate ids are ignored, widths are clamped,
 * columns the state does not name are appended, and at least one column stays visible.
 */
export function normalizeColumnState<Row>(
  raw: unknown,
  columns: readonly ResolvedColumn<Row>[],
): GridColumnState {
  const base = defaultColumnState(columns);
  if (!isRecord(raw) || raw.version !== 1) return base;
  const known = new Map(columns.map((c) => [c.id, c]));
  const entries = new Map<string, GridColumnEntry>();
  for (const item of Array.isArray(raw.columns)
    ? (raw.columns as unknown[])
    : []) {
    if (!isRecord(item) || typeof item.id !== 'string') continue;
    const column = known.get(item.id);
    if (!column || entries.has(column.id)) continue;
    const width = item.width;
    entries.set(column.id, {
      id: column.id,
      hidden: item.hidden === true,
      width:
        typeof width === 'number' && Number.isFinite(width)
          ? clampWidth(width, column)
          : column.width,
      pinned:
        item.pinned === 'left' || item.pinned === 'right' ? item.pinned : null,
    });
  }
  const ordered = [
    ...entries.values(),
    ...base.columns.filter((c) => !entries.has(c.id)),
  ];
  const sort: GridSort[] = [];
  for (const s of Array.isArray(raw.sort) ? (raw.sort as unknown[]) : []) {
    if (!isRecord(s) || typeof s.columnId !== 'string') continue;
    const id = s.columnId;
    if (known.get(id)?.sortable !== true || sort.some((x) => x.columnId === id))
      continue;
    if (s.direction === 'asc' || s.direction === 'desc')
      sort.push({ columnId: id, direction: s.direction });
  }
  return { version: 1, columns: ensureOneVisible(ordered), sort };
}

export function hideColumn(
  state: GridColumnState,
  id: string,
): GridColumnState {
  const visible = state.columns.filter((c) => c.hidden !== true);
  if (visible.length === 1 && visible[0]?.id === id) return state; // the last visible column stays
  return patch(state, id, { hidden: true });
}

export function showColumn(
  state: GridColumnState,
  id: string,
): GridColumnState {
  return patch(state, id, { hidden: false });
}

export function resizeColumn<Row>(
  state: GridColumnState,
  columns: readonly ResolvedColumn<Row>[],
  id: string,
  width: number,
): GridColumnState {
  const column = columns.find((c) => c.id === id);
  if (!column || !Number.isFinite(width)) return state;
  return patch(state, id, { width: clampWidth(width, column) });
}

/** Moves a column to `toIndex` in the display order. */
export function moveColumn(
  state: GridColumnState,
  id: string,
  toIndex: number,
): GridColumnState {
  const from = state.columns.findIndex((c) => c.id === id);
  if (from < 0 || !Number.isInteger(toIndex)) return state;
  const next = [...state.columns];
  const [moved] = next.splice(from, 1);
  if (!moved) return state;
  next.splice(Math.min(Math.max(toIndex, 0), next.length), 0, moved);
  return { ...state, columns: next };
}

function patch(
  state: GridColumnState,
  id: string,
  change: Partial<GridColumnEntry>,
): GridColumnState {
  if (!state.columns.some((c) => c.id === id)) return state;
  return {
    ...state,
    columns: state.columns.map((c) => (c.id === id ? { ...c, ...change } : c)),
  };
}

function ensureOneVisible(
  entries: readonly GridColumnEntry[],
): readonly GridColumnEntry[] {
  if (entries.length === 0 || entries.some((c) => c.hidden !== true))
    return entries;
  return entries.map((c, i) => (i === 0 ? { ...c, hidden: false } : c));
}

function clampWidth<Row>(width: number, column: ResolvedColumn<Row>): number {
  return Math.min(
    COLUMN_MAX_WIDTH,
    Math.max(column.minWidth, COLUMN_MIN_WIDTH, width),
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
