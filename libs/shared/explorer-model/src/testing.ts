// A deterministic fake `ExplorerData` for specs and the perf harness (M0-54): N rows per kind, a
// version history of two (like the engine's index), one controllable topic, failures and held
// answers. Rows, filters and sorts follow what `svc-explorer` does (a case-insensitive substring of
// the name, exact facet values, one sort column, the key as the tie-break), so a spec exercises the
// same shapes; it is not the engine, and a spec that needs the engine uses the real action.
// Exported as `@app/explorer-model/testing`; never imported by production code.
import { encodeObjectKey, EXPLORER_VERSION_KEY } from '@app/contracts';

import type {
  ExplorerData,
  ExplorerKind,
  ExplorerLiveEvent,
  ExplorerWindowItem,
  ExplorerWindowParams,
  Freshness,
  InventoryQueryInput,
  InventoryQueryOutput,
  InventoryRows,
} from './ports';

export type FakeRows = { [K in ExplorerKind]: InventoryRows[K][] };

export interface FakeExplorerOptions {
  /** Rows per kind; default 400 queues, 60 exchanges, 60 connections and 40 bindings per vhost. */
  readonly rows?: Partial<Record<ExplorerKind, number>>;
  /** The vhosts the rows are spread over; default `/` and `orders`. */
  readonly vhosts?: readonly string[];
  /** The first index version; default 7. */
  readonly version?: number;
  /** Deliver the snapshot (the followed rows and the marker) as soon as a follower subscribes. */
  readonly autoSnapshot?: boolean;
}

export interface FakeFollower {
  readonly params: ExplorerWindowParams;
  readonly listener: (event: ExplorerLiveEvent) => void;
  active: boolean;
}

export interface FakeExplorerData extends ExplorerData {
  /** Every `inventory.query` input, in order. */
  readonly queries: readonly InventoryQueryInput[];
  /** The abort signal of each query, in the same order (a source that was replaced aborts its own). */
  readonly signals: readonly AbortSignal[];
  /** The most queries that were in flight at once. */
  readonly maxInflight: number;
  /** Every `follow`, in order; `active` is false once its unsubscribe ran. */
  readonly followers: readonly FakeFollower[];
  readonly version: number;
  /** The rows of the current version, for assertions. */
  rows(): Readonly<FakeRows>;
  /** Installs a new version (the previous one stays readable, as in the engine's index). */
  bump(mutate?: (rows: FakeRows) => void): number;
  /** Replaces what the answers say about their freshness. */
  setFreshness(patch: Partial<Freshness> | null): void;
  /** The next query rejects with this error. */
  failNext(error?: unknown): void;
  /** Queries wait until released, in the order they were asked; `release(n)` answers the first n (all by default). */
  hold(): { release(count?: number): void };
  /** Sends an event to every active follower (or one). */
  emit(event: ExplorerLiveEvent, follower?: FakeFollower): void;
  /** The snapshot a follower gets: its keys that exist, then the marker at the current version. */
  snapshotFor(params: ExplorerWindowParams): ExplorerLiveEvent;
}

const FIXED_SWEPT_AT = 1_700_000_000_000;
const QUEUE_TYPES = ['classic', 'quorum', 'stream'] as const;
const EXCHANGE_TYPES = ['direct', 'fanout', 'topic', 'headers'] as const;
const pad = (n: number, width = 5): string => String(n).padStart(width, '0');

function buildRows(
  options: FakeExplorerOptions,
  vhosts: readonly string[],
): FakeRows {
  const count = (kind: ExplorerKind, fallback: number): number =>
    options.rows?.[kind] ?? fallback;
  const vhostOf = (i: number): string => vhosts[i % vhosts.length] ?? '/';
  const queues: InventoryRows['queues'][] = [];
  for (let i = 0; i < count('queues', 400); i++) {
    const vhost = vhostOf(i);
    const name = `queue-${pad(i)}`;
    queues.push({
      key: encodeObjectKey(vhost, name),
      vhost,
      name,
      type: QUEUE_TYPES[i % QUEUE_TYPES.length] ?? 'classic',
      state: i % 50 === 0 ? 'idle' : 'running',
      durable: true,
      autoDelete: false,
      exclusive: false,
      messages: (i * 7) % 1000,
      messagesReady: (i * 5) % 1000,
      messagesUnacknowledged: (i * 2) % 1000,
      consumers: i % 4,
      policy: i % 3 === 0 ? 'ha-all' : undefined,
    });
  }
  const exchanges: InventoryRows['exchanges'][] = [];
  for (let i = 0; i < count('exchanges', 60); i++) {
    const vhost = vhostOf(i);
    const name = `exchange-${pad(i)}`;
    exchanges.push({
      key: encodeObjectKey(vhost, name),
      vhost,
      name,
      type: EXCHANGE_TYPES[i % EXCHANGE_TYPES.length] ?? 'direct',
      durable: true,
      autoDelete: false,
      internal: false,
    });
  }
  const connections: InventoryRows['connections'][] = [];
  for (let i = 0; i < count('connections', 60); i++) {
    const vhost = vhostOf(i);
    const name = `10.0.0.${String(i % 250)}:${String(40000 + i)} -> 10.0.1.1:5672`;
    connections.push({
      key: encodeObjectKey(vhost, name),
      vhost,
      name,
      user: 'guest',
      node: 'rabbit@node1',
      state: 'running',
      protocol: 'AMQP 0-9-1',
      channels: i % 5,
      peerHost: `10.0.0.${String(i % 250)}`,
      ssl: false,
    });
  }
  const bindings: InventoryRows['bindings'][] = [];
  for (let i = 0; i < count('bindings', 40) * vhosts.length; i++) {
    const vhost = vhostOf(i);
    const source = `exchange-${pad(i)}`;
    const destination = `queue-${pad(i)}`;
    bindings.push({
      key: encodeObjectKey(
        vhost,
        `${source}|queue|${destination}|k${String(i)}`,
      ),
      vhost,
      source,
      destination,
      destinationType: 'queue',
      routingKey: `k${String(i)}`,
      propertiesKey: `k${String(i)}`,
    });
  }
  return { queues, exchanges, connections, bindings };
}

type AnyRow = InventoryRows[ExplorerKind] & Record<string, unknown>;

function matcher(
  filter: InventoryQueryInput['filter'],
): ((row: AnyRow) => boolean) | undefined {
  if (filter === undefined) return undefined;
  const text = filter.text?.toLowerCase();
  const vhosts = filter.vhosts && new Set(filter.vhosts);
  const types = filter.types && new Set(filter.types);
  const states = filter.states && new Set(filter.states);
  return (row) => {
    const type = (row.type ?? row.protocol) as string | undefined;
    const name = (row.name ?? row.source) as string;
    const consumers = row.consumers as number | undefined;
    const messages = row.messages as number | undefined;
    return (
      (text === undefined ||
        name.toLowerCase().includes(text) ||
        (row.destination as string | undefined)
          ?.toLowerCase()
          .includes(text) === true ||
        (row.routingKey as string | undefined)?.toLowerCase().includes(text) ===
          true) &&
      (vhosts === undefined ||
        (row.vhost !== undefined && vhosts.has(row.vhost))) &&
      (types === undefined || (type !== undefined && types.has(type))) &&
      (states === undefined ||
        (row.state !== undefined && states.has(row.state as string))) &&
      (filter.hasConsumers === undefined ||
        (consumers !== undefined && consumers > 0 === filter.hasConsumers)) &&
      (filter.minMessages === undefined ||
        (messages !== undefined && messages >= filter.minMessages))
    );
  };
}

function comparator(column: string, dir: 'asc' | 'desc') {
  const sign = dir === 'asc' ? 1 : -1;
  const value = (row: AnyRow) =>
    row[column] as string | number | boolean | undefined;
  return (a: AnyRow, b: AnyRow): number => {
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

interface Snapshot {
  readonly version: number;
  readonly rows: Readonly<FakeRows>;
}

export function createFakeExplorerData(
  options: FakeExplorerOptions = {},
): FakeExplorerData {
  const vhosts = options.vhosts ?? ['/', 'orders'];
  let current: Snapshot = {
    version: options.version ?? 7,
    rows: buildRows(options, vhosts),
  };
  let previous: Snapshot | undefined;
  let freshnessPatch: Partial<Freshness> | null = null;
  let failure: { error: unknown } | undefined;
  let holding: (() => void)[] | undefined;
  const queries: InventoryQueryInput[] = [];
  const signals: AbortSignal[] = [];
  const followers: FakeFollower[] = [];
  const sortCache = new Map<string, readonly AnyRow[]>();

  const sorted = (
    snap: Snapshot,
    kind: ExplorerKind,
    column: string,
    dir: 'asc' | 'desc',
  ): readonly AnyRow[] => {
    const id = `${String(snap.version)}|${kind}|${column}|${dir}`;
    let hit = sortCache.get(id);
    if (hit === undefined) {
      hit = [...(snap.rows[kind] as AnyRow[])].sort(comparator(column, dir));
      if (sortCache.size >= 8) {
        const oldest = sortCache.keys().next();
        if (!oldest.done) sortCache.delete(oldest.value);
      }
      sortCache.set(id, hit);
    }
    return hit;
  };

  let inflight = 0;
  let maxInflight = 0;
  const query = async (
    input: InventoryQueryInput,
    signal: AbortSignal,
  ): Promise<InventoryQueryOutput> => {
    signals.push(signal);
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    try {
      return await answer(input, signal);
    } finally {
      inflight -= 1;
    }
  };

  const answer = async (
    input: InventoryQueryInput,
    signal: AbortSignal,
  ): Promise<InventoryQueryOutput> => {
    queries.push(input);
    if (holding !== undefined) {
      await new Promise<void>((resolve) => holding?.push(resolve));
    }
    signal.throwIfAborted();
    if (failure !== undefined) {
      const { error } = failure;
      failure = undefined;
      throw error;
    }
    const { kind, window } = input;
    const pinned = window.version;
    const snap =
      pinned === undefined || pinned === current.version
        ? current
        : previous?.version === pinned
          ? previous
          : current;
    const all = sorted(
      snap,
      kind,
      input.sort?.column ?? 'name',
      input.sort?.dir ?? 'asc',
    );
    // A bindings query needs exactly one vhost; the fake refuses like the engine does.
    if (kind === 'bindings' && input.filter?.vhosts?.length !== 1) {
      throw new Error(
        'A bindings query names exactly one vhost in filter.vhosts.',
      );
    }
    const keep = matcher(input.filter);
    const found = keep ? all.filter(keep) : all;
    const { limit } = window;
    const rows = found.slice(window.offset, window.offset + limit);
    const freshness: Freshness = {
      state: 'live',
      sweptAt: FIXED_SWEPT_AT,
      complete: true,
      loaded: all.length,
      truncated: false,
      dropped: 0,
      hazards: [],
      versionChanged: pinned !== undefined && snap.version !== pinned,
      ...freshnessPatch,
    };
    return {
      kind,
      rows,
      window: { offset: window.offset, limit },
      total: all.length,
      matched: found.length,
      version: snap.version,
      freshness,
    } as InventoryQueryOutput;
  };

  const itemOf = (row: AnyRow, version: number): ExplorerWindowItem => {
    const { key, ...rest } = row;
    return { key, version, row: rest } as ExplorerWindowItem;
  };

  const snapshotFor = (params: ExplorerWindowParams): ExplorerLiveEvent => {
    const byKey = new Map(
      (current.rows[params.kind] as AnyRow[]).map((r) => [r.key, r]),
    );
    const items: ExplorerWindowItem[] = [];
    for (const key of params.keys) {
      const row = byKey.get(key as never);
      if (row !== undefined) items.push(itemOf(row, current.version));
    }
    items.push({ key: EXPLORER_VERSION_KEY, version: current.version });
    return { kind: 'snapshot', items };
  };

  return {
    queries,
    signals,
    get maxInflight() {
      return maxInflight;
    },
    followers,
    get version() {
      return current.version;
    },
    rows: () => current.rows,
    bump(mutate) {
      const rows: FakeRows = {
        queues: [...current.rows.queues],
        exchanges: [...current.rows.exchanges],
        connections: [...current.rows.connections],
        bindings: [...current.rows.bindings],
      };
      mutate?.(rows);
      previous = current;
      current = { version: current.version + 1, rows };
      return current.version;
    },
    setFreshness(patch) {
      freshnessPatch = patch;
    },
    failNext(error = new Error('fake failure')) {
      failure = { error };
    },
    hold() {
      holding = [];
      return {
        release: (count = Number.POSITIVE_INFINITY) => {
          const waiting = holding ?? [];
          const released = waiting.splice(0, count);
          if (waiting.length === 0 && count === Number.POSITIVE_INFINITY)
            holding = undefined;
          for (const resolve of released) resolve();
        },
      };
    },
    query,
    follow(params, listener) {
      const follower: FakeFollower = { params, listener, active: true };
      followers.push(follower);
      if (options.autoSnapshot === true) {
        queueMicrotask(() => {
          if (follower.active) listener(snapshotFor(params));
        });
      }
      return () => {
        follower.active = false;
      };
    },
    emit(event, follower) {
      for (const f of follower ? [follower] : followers) {
        if (f.active) f.listener(event);
      }
    },
    snapshotFor,
  };
}
