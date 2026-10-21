// The engine-resident inventory index of one connection: bounded by rows and bytes (I-6) with every
// drop counted, versioned (a finished sweep installs a kind as a new version; the previous version
// stays readable for pinned windows), and read through filter, sort and window (I-7).
import {
  SWEPT_KINDS,
  type InventoryFilterSchema,
  type InventorySortSchema,
  type SweptKind,
} from '@app/contracts';
import type { z } from 'zod';

import { DEFAULT_EXPLORER_LIMITS, type ExplorerLimits } from '../deps';

import type { IndexRow, QueueRow, RowOf } from './rows';

type InventoryFilter = z.infer<typeof InventoryFilterSchema>;
type InventorySort = z.infer<typeof InventorySortSchema>;
export const KINDS: readonly SweptKind[] = SWEPT_KINDS;

export interface IndexVersion {
  readonly version: number;
  readonly sweptAt: number;
  /** Every kind is installed and none was read partially. */
  readonly complete: boolean;
  /** Rows the caps dropped from this version, counted. */
  readonly dropped: number;
  readonly truncated: boolean;
  /** The last sweep did not finish; the rows are from the last good one. */
  readonly stale: boolean;
}

export interface WindowQuery {
  kind: SweptKind;
  filter?: InventoryFilter | undefined;
  sort?: InventorySort | undefined;
  offset: number;
  limit: number;
  /** Pins the read to an earlier answer's version. */
  version?: number | undefined;
}

export interface QueueTotals {
  readonly version: IndexVersion;
  readonly queues: number;
  /** The queues were read whole (no vhost skipped). */
  readonly complete: boolean;
  /** Queues the caps dropped. */
  readonly dropped: number;
  readonly messages: number;
  readonly ready: number;
  readonly unacknowledged: number;
  /** Queues that lacked at least one of the three counts. */
  readonly unreported: number;
}

export interface IndexChange {
  kind: SweptKind;
  version: number;
  upserts: readonly IndexRow[];
  removes: readonly string[];
  membershipChanged: boolean;
}

interface InstallMeta {
  sweptAt: number;
  complete: boolean;
  /** Rows the sweeper itself left out of `rows`, already counted as dropped. */
  extraDropped?: number;
}
interface InstallEntry {
  kind: SweptKind;
  rows: Iterable<IndexRow>;
  meta: InstallMeta;
}

export interface InventoryIndex {
  /** Replaces the rows of one kind with a finished sweep, atomically; keeps the previous version. */
  install(
    kind: SweptKind,
    rows: Iterable<IndexRow>,
    meta: InstallMeta,
  ): IndexVersion;
  /** Replaces several kinds as one new version (the end of a sweep over a warm index). */
  installAll(entries: readonly InstallEntry[]): IndexVersion;
  window(query: WindowQuery): {
    rows: readonly IndexRow[];
    matched: number;
    total: number;
    version: IndexVersion;
    versionChanged: boolean;
  };
  byKeys(kind: SweptKind, keys: readonly string[]): readonly IndexRow[];
  /** The rows of the current version of a kind, in sweep order (empty until installed). Read only. */
  rows<K extends SweptKind>(kind: K): readonly RowOf<K>[];
  /**
   * The case-folded name of each row of `rows(kind)`, same order. Built on first use and kept with
   * the version (dropped with it); its bytes are in `stats.bytes`. Read only.
   */
  folded(kind: SweptKind): readonly string[];
  /**
   * The message counts of the current queues, summed in one pass (no sort, no window). A queue
   * that did not report a count adds nothing and is counted in `unreported`; undefined until the
   * queues have been installed.
   */
  queueTotals(): QueueTotals | undefined;
  /** The kind has been installed at least once. */
  has(kind: SweptKind): boolean;
  /** The version the index is at now (0 before the first install). */
  current(): IndexVersion;
  setStale(stale: boolean): void;
  subscribe(listener: (change: IndexChange) => void): () => void;
  readonly stats: { rows: number; bytes: number; dropped: number };
}

interface KindData {
  readonly rows: readonly IndexRow[];
  readonly bytes: number;
  readonly dropped: number;
  readonly complete: boolean;
  byKey?: Map<string, IndexRow>;
  /** Case-folded names for the search, built lazily; at most one more copy of the names. */
  folded?: readonly string[];
  foldedBytes?: number;
}
interface Snapshot {
  readonly meta: IndexVersion;
  readonly kinds: Readonly<Partial<Record<SweptKind, KindData>>>;
}

const ROW_OVERHEAD_BYTES = 256;
/** A reference in the folded-name list, in the estimate. */
const REFERENCE_BYTES = 8;

/** A cheap estimate: a fixed overhead plus two bytes per character of the strings. */
function rowBytes(row: IndexRow): number {
  return ROW_OVERHEAD_BYTES + 2 * (row.name.length + (row.vhost ?? '').length);
}

function sameRow(a: IndexRow, b: IndexRow): boolean {
  const left = Object.entries(a);
  return (
    left.length === Object.keys(b).length &&
    left.every(([k, v]) => (b as Record<string, unknown>)[k] === v)
  );
}

function matcher(
  filter: InventoryFilter | undefined,
): ((row: IndexRow) => boolean) | undefined {
  if (filter === undefined) return undefined;
  const text = filter.text?.toLowerCase();
  const vhosts = filter.vhosts && new Set(filter.vhosts);
  const types = filter.types && new Set(filter.types);
  const states = filter.states && new Set(filter.states);
  return (row) => {
    const q = row as Partial<QueueRow>;
    // The facet `types` is the queue type, the exchange type or, for a connection, the protocol.
    const type = q.type ?? (row as { protocol?: string }).protocol;
    return (
      (text === undefined || row.name.toLowerCase().includes(text)) &&
      (vhosts === undefined ||
        (row.vhost !== undefined && vhosts.has(row.vhost))) &&
      (types === undefined || (type !== undefined && types.has(type))) &&
      (states === undefined ||
        (q.state !== undefined && states.has(q.state))) &&
      (filter.hasConsumers === undefined ||
        (q.consumers !== undefined &&
          q.consumers > 0 === filter.hasConsumers)) &&
      (filter.minMessages === undefined ||
        (q.messages !== undefined && q.messages >= filter.minMessages))
    );
  };
}

/** Missing values first; the key always breaks a tie, so windows never overlap. */
export function comparator<R extends { key: string }>(sort: InventorySort) {
  const sign = sort.dir === 'asc' ? 1 : -1;
  const value = (row: R) =>
    (row as unknown as Record<string, string | number | boolean | undefined>)[
      sort.column
    ];
  return (a: R, b: R): number => {
    const x = value(a);
    const y = value(b);
    if (x !== y) {
      if (x === undefined) return -sign;
      if (y === undefined) return sign;
      return (x < y ? -1 : 1) * sign;
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  };
}

export function createInventoryIndex(
  limits: Pick<
    ExplorerLimits,
    'maxRowsPerConnection' | 'maxBytesPerConnection'
  > &
    Partial<Pick<ExplorerLimits, 'sortCacheEntriesPerKind'>>,
): InventoryIndex {
  const sortCacheEntries = Math.max(
    1,
    limits.sortCacheEntriesPerKind ??
      DEFAULT_EXPLORER_LIMITS.sortCacheEntriesPerKind,
  );
  const empty: Snapshot = {
    meta: {
      version: 0,
      sweptAt: 0,
      complete: false,
      dropped: 0,
      truncated: false,
      stale: false,
    },
    kinds: {},
  };
  let current = empty;
  let previous: Snapshot | undefined;
  let droppedTotal = 0;
  const listeners = new Set<(change: IndexChange) => void>();
  // One FIFO per kind, so a busy kind never pushes out another kind's sorts (I-6: each is bounded).
  const sortCache = new Map<SweptKind, Map<string, readonly IndexRow[]>>();

  const sum = (snap: Snapshot, field: 'bytes' | 'dropped', skip?: string) =>
    KINDS.reduce(
      (n, k) => n + (k === skip ? 0 : (snap.kinds[k]?.[field] ?? 0)),
      0,
    );
  const rowCount = (snap: Snapshot, skip?: string) =>
    KINDS.reduce(
      (n, k) => n + (k === skip ? 0 : (snap.kinds[k]?.rows.length ?? 0)),
      0,
    );

  function sorted(snap: Snapshot, kind: SweptKind, sort: InventorySort) {
    const id = `${String(snap.meta.version)}|${sort.column}|${sort.dir}`;
    let cache = sortCache.get(kind);
    if (cache === undefined) {
      cache = new Map();
      sortCache.set(kind, cache);
    }
    let hit = cache.get(id);
    if (hit === undefined) {
      hit = [...(snap.kinds[kind]?.rows ?? [])].sort(comparator(sort));
      if (cache.size >= sortCacheEntries) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      cache.set(id, hit);
    }
    return hit;
  }

  function foldedNames(kind: SweptKind): readonly string[] {
    const data = current.kinds[kind];
    if (data === undefined) return [];
    if (data.folded === undefined) {
      let bytes = 0;
      const names: string[] = [];
      for (const row of data.rows) {
        const name = row.name.toLowerCase();
        names.push(name);
        bytes += REFERENCE_BYTES + 2 * name.length;
      }
      data.folded = names;
      data.foldedBytes = bytes;
    }
    return data.folded;
  }

  /** Applies finished kinds as ONE new version, so a pinned scroll survives a whole sweep. */
  function installAll(entries: readonly InstallEntry[]): IndexVersion {
    let kinds = current.kinds;
    const changes: { kind: SweptKind; kept: IndexRow[] }[] = [];
    for (const { kind, rows, meta } of entries) {
      const others = { ...current, kinds };
      let maxRows = limits.maxRowsPerConnection - rowCount(others, kind);
      const maxBytes =
        limits.maxBytesPerConnection - sum(others, 'bytes', kind);
      const kept: IndexRow[] = [];
      let bytes = 0;
      let dropped = meta.extraDropped ?? 0;
      for (const row of rows) {
        const size = rowBytes(row);
        if (kept.length < maxRows && bytes + size <= maxBytes) {
          kept.push(row);
          bytes += size;
        } else {
          // Everything past the first row that does not fit is dropped, in sweep order.
          maxRows = kept.length;
          dropped++;
        }
      }
      droppedTotal += dropped;
      kinds = {
        ...kinds,
        [kind]: { rows: kept, bytes, dropped, complete: meta.complete },
      };
      changes.push({ kind, kept });
    }
    const totals = { ...current, kinds };
    const next: Snapshot = {
      kinds,
      meta: {
        version: current.meta.version + 1,
        sweptAt: entries.at(-1)?.meta.sweptAt ?? current.meta.sweptAt,
        complete: KINDS.every((k) => kinds[k]?.complete === true),
        dropped: sum(totals, 'dropped'),
        truncated: sum(totals, 'dropped') > 0,
        stale: false,
      },
    };
    const before = current;
    previous = current.meta.version === 0 ? undefined : current;
    current = next;
    if (listeners.size > 0) {
      for (const { kind, kept } of changes) {
        const old = new Map(
          (before.kinds[kind]?.rows ?? []).map((r) => [r.key as string, r]),
        );
        const upserts = kept.filter((r) => {
          const was = old.get(r.key);
          return was === undefined || !sameRow(was, r);
        });
        const keys = new Set(kept.map((r) => r.key as string));
        const removes = [...old.keys()].filter((k) => !keys.has(k));
        const added = upserts.some((r) => !old.has(r.key));
        for (const listener of listeners) {
          listener({
            kind,
            version: next.meta.version,
            upserts,
            removes,
            membershipChanged: added || removes.length > 0,
          });
        }
      }
    }
    return next.meta;
  }

  return {
    install: (kind, rows, meta) => installAll([{ kind, rows, meta }]),
    installAll,
    window(query) {
      const pinned = query.version;
      const snap =
        pinned === undefined || pinned === current.meta.version
          ? current
          : previous?.meta.version === pinned
            ? previous
            : current;
      const all = sorted(
        snap,
        query.kind,
        query.sort ?? {
          column: 'name',
          dir: 'asc',
        },
      );
      const keep = matcher(query.filter);
      const found = keep ? all.filter(keep) : all;
      return {
        rows: found.slice(query.offset, query.offset + query.limit),
        matched: found.length,
        total: all.length,
        version: snap.meta,
        versionChanged: pinned !== undefined && snap.meta.version !== pinned,
      };
    },
    byKeys(kind, keys) {
      const data = current.kinds[kind];
      if (data === undefined) return [];
      data.byKey ??= new Map(data.rows.map((r) => [r.key as string, r]));
      const lookup = data.byKey;
      return keys.flatMap((k) => lookup.get(k) ?? []);
    },
    rows: <K extends SweptKind>(kind: K) =>
      (current.kinds[kind]?.rows ?? []) as readonly RowOf<K>[],
    queueTotals() {
      const data = current.kinds.queues;
      if (data === undefined) return undefined;
      const totals = {
        messages: 0,
        ready: 0,
        unacknowledged: 0,
        unreported: 0,
      };
      for (const row of data.rows as readonly QueueRow[]) {
        totals.messages += row.messages ?? 0;
        totals.ready += row.messagesReady ?? 0;
        totals.unacknowledged += row.messagesUnacknowledged ?? 0;
        if (
          row.messages === undefined ||
          row.messagesReady === undefined ||
          row.messagesUnacknowledged === undefined
        ) {
          totals.unreported++;
        }
      }
      return {
        ...totals,
        version: current.meta,
        queues: data.rows.length,
        complete: data.complete,
        dropped: data.dropped,
      };
    },
    folded: foldedNames,
    has: (kind) => current.kinds[kind] !== undefined,
    current: () => current.meta,
    setStale(stale) {
      current = { ...current, meta: { ...current.meta, stale } };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get stats() {
      return {
        rows: rowCount(current),
        // The rows as estimated at install, plus the folded names where a search has built them.
        bytes:
          sum(current, 'bytes') +
          KINDS.reduce((n, k) => n + (current.kinds[k]?.foldedBytes ?? 0), 0),
        dropped: droppedTotal,
      };
    },
  };
}
