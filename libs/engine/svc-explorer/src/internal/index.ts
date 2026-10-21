// The engine-resident inventory index of one connection: bounded by rows and bytes (I-6) with every
// drop counted, versioned (a finished sweep installs a kind as a new version; the previous version
// stays readable for pinned windows), and read through filter, sort and window (I-7).
import type {
  InventoryFilterSchema,
  InventoryKind,
  InventorySortSchema,
} from '@app/contracts';
import type { z } from 'zod';

import type { ExplorerLimits } from '../deps';

import type { IndexRow, QueueRow } from './rows';

type InventoryFilter = z.infer<typeof InventoryFilterSchema>;
type InventorySort = z.infer<typeof InventorySortSchema>;
export const KINDS: readonly InventoryKind[] = ['queues', 'exchanges'];

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
  kind: InventoryKind;
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
  kind: InventoryKind;
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
  kind: InventoryKind;
  rows: Iterable<IndexRow>;
  meta: InstallMeta;
}

export interface InventoryIndex {
  /** Replaces the rows of one kind with a finished sweep, atomically; keeps the previous version. */
  install(
    kind: InventoryKind,
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
  byKeys(kind: InventoryKind, keys: readonly string[]): readonly IndexRow[];
  /** The rows of the current version of a kind, in sweep order (empty until installed). Read only. */
  rows(kind: InventoryKind): readonly IndexRow[];
  /**
   * The message counts of the current queues, summed in one pass (no sort, no window). A queue
   * that did not report a count adds nothing and is counted in `unreported`; undefined until the
   * queues have been installed.
   */
  queueTotals(): QueueTotals | undefined;
  /** The kind has been installed at least once. */
  has(kind: InventoryKind): boolean;
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
}
interface Snapshot {
  readonly meta: IndexVersion;
  readonly kinds: Readonly<Partial<Record<InventoryKind, KindData>>>;
}

const SORT_CACHE_ENTRIES = 4;
const ROW_OVERHEAD_BYTES = 256;

/** A cheap estimate: a fixed overhead plus two bytes per character of the strings. */
function rowBytes(row: IndexRow): number {
  return ROW_OVERHEAD_BYTES + 2 * (row.name.length + row.vhost.length);
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
    return (
      (text === undefined || row.name.toLowerCase().includes(text)) &&
      (vhosts === undefined || vhosts.has(row.vhost)) &&
      (types === undefined ||
        (row.type !== undefined && types.has(row.type))) &&
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
function comparator(sort: InventorySort) {
  const sign = sort.dir === 'asc' ? 1 : -1;
  const value = (row: IndexRow) =>
    (row as unknown as Record<string, string | number | boolean | undefined>)[
      sort.column
    ];
  return (a: IndexRow, b: IndexRow): number => {
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
  >,
): InventoryIndex {
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
  const sortCache = new Map<string, readonly IndexRow[]>();

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

  function sorted(snap: Snapshot, kind: InventoryKind, sort: InventorySort) {
    const id = `${String(snap.meta.version)}|${kind}|${sort.column}|${sort.dir}`;
    let hit = sortCache.get(id);
    if (hit === undefined) {
      hit = [...(snap.kinds[kind]?.rows ?? [])].sort(comparator(sort));
      if (sortCache.size >= SORT_CACHE_ENTRIES) {
        const oldest = sortCache.keys().next();
        if (!oldest.done) sortCache.delete(oldest.value);
      }
      sortCache.set(id, hit);
    }
    return hit;
  }

  /** Applies finished kinds as ONE new version, so a pinned scroll survives a whole sweep. */
  function installAll(entries: readonly InstallEntry[]): IndexVersion {
    let kinds = current.kinds;
    const changes: { kind: InventoryKind; kept: IndexRow[] }[] = [];
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
    rows: (kind) => current.kinds[kind]?.rows ?? [],
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
        bytes: sum(current, 'bytes'),
        dropped: droppedTotal,
      };
    },
  };
}
