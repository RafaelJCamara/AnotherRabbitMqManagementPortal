// One entity, read and followed (M1-42, R3 and R4). The engine has no `queues.get`: an object is read by
// following exactly its key on `explorer.window` (a snapshot holds the row when the key is in the index and
// not otherwise, then deltas) and by reading one row of the kind for the freshness, which decides whether
// "not in the index" means "not on the broker". A binding has no topic: it is found by its key over the
// windows of its vhost. Nothing here polls, and nothing reads a message.
import { ConnectionIdSchema, EXPLORER_VERSION_KEY } from '@app/contracts';

import { bindingParts, parseEntityPath } from './entity-address';
import type {
  ExplorerData,
  ExplorerKind,
  ExplorerLiveEvent,
  Freshness,
  InventoryQueryInput,
  InventoryRow,
} from './ports';
import { scanBindings } from './related-bindings';

export type EntityPhase =
  | 'loading'
  | 'found'
  /** Not in the index; see `certain`. */
  | 'missing'
  /** The row was shown and has since been removed; `row` is the last one read. */
  | 'vanished'
  /** Nothing could be read; `problem` is the failure as received. */
  | 'error';

export interface EntityState {
  readonly phase: EntityPhase;
  /** The row read (the last one, for `vanished`); `null` when none was. */
  readonly row: InventoryRow | null;
  /** For `missing`: the inventory is live and complete, so the object is not on the broker. */
  readonly certain: boolean;
  /** What the index said about itself, or `null` before it was read. */
  readonly freshness: Freshness | null;
  /** Why the freshness could not be read, as received. */
  readonly freshnessProblem: unknown;
  /** The topic: `off` for bindings. */
  readonly live: 'off' | 'connecting' | 'following' | 'ended';
  /** The failure of an `error`, or what ended the topic after a row was read. */
  readonly problem: unknown;
  /** Gaps the topic reported (I-13: counted). */
  readonly gaps: number;
  /** Reads of the freshness (or of the bindings of the vhost) started. */
  readonly reads: number;
}

export interface EntityWatch {
  state(): EntityState;
  onState(listener: (state: EntityState) => void): () => void;
  /** Reads the freshness (and, for a binding, the row) again. */
  refresh(): void;
  /** Aborts what is in flight and ends the subscription. */
  destroy(): void;
}

export interface EntityQuery {
  readonly cid: string;
  readonly kind: ExplorerKind;
  readonly key: string;
}

/** The index is live, complete, and left nothing out: what it lacks is not on the broker. */
export function isCertain(freshness: Freshness | null): boolean {
  return (
    freshness !== null &&
    freshness.state === 'live' &&
    freshness.complete &&
    !freshness.truncated &&
    freshness.dropped === 0
  );
}

const INITIAL: EntityState = {
  phase: 'loading',
  row: null,
  certain: false,
  freshness: null,
  freshnessProblem: null,
  live: 'off',
  problem: null,
  gaps: 0,
  reads: 0,
};

function makeStore(initial: EntityState) {
  let state = initial;
  const listeners = new Set<(state: EntityState) => void>();
  return {
    get: () => state,
    set: (patch: Partial<EntityState>): void => {
      state = { ...state, ...patch };
      for (const listener of listeners) listener(state);
    },
    subscribe: (listener: (state: EntityState) => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** A swept kind: one key on the topic, one row of the kind for the freshness. */
function watchFollowed(
  data: ExplorerData,
  query: EntityQuery & {
    readonly kind: 'queues' | 'exchanges' | 'connections';
  },
): EntityWatch {
  const cid = ConnectionIdSchema.parse(query.cid);
  const store = makeStore({ ...INITIAL, live: 'connecting' });
  let destroyed = false;
  let reading: AbortController | null = null;
  let snapshotSeen = false;
  let absent = false;
  let removed = false;
  let row: InventoryRow | null = null;
  let fatal: { readonly error: unknown } | null = null;

  /** The phase follows from what was read; the freshness decides how sure an absence is. */
  const settle = (): void => {
    const { freshness, freshnessProblem } = store.get();
    if (row !== null) {
      store.set({
        row,
        phase: removed ? 'vanished' : 'found',
        certain: false,
      });
    } else if (fatal !== null) {
      store.set({ phase: 'error', problem: fatal.error, certain: false });
    } else if (snapshotSeen && absent) {
      const known = freshness !== null || freshnessProblem !== null;
      store.set({
        phase: known ? 'missing' : 'loading',
        certain: isCertain(freshness),
      });
    } else {
      store.set({ phase: 'loading', certain: false });
    }
  };

  const readFreshness = (): void => {
    reading?.abort();
    const controller = new AbortController();
    reading = controller;
    store.set({ reads: store.get().reads + 1 });
    const input: InventoryQueryInput = {
      cid,
      kind: query.kind,
      window: { offset: 0, limit: 1 },
    };
    data.query(input, controller.signal).then(
      (out) => {
        if (destroyed || controller.signal.aborted) return;
        store.set({ freshness: out.freshness, freshnessProblem: null });
        settle();
      },
      (error: unknown) => {
        if (destroyed || controller.signal.aborted) return;
        store.set({ freshnessProblem: error });
        settle();
      },
    );
  };

  const rowOf = (
    items: readonly { key: string; row?: object | undefined }[],
  ): InventoryRow | undefined => {
    const item = items.find(
      (candidate) =>
        candidate.key === query.key && candidate.key !== EXPLORER_VERSION_KEY,
    );
    return item?.row === undefined
      ? undefined
      : ({ ...item.row, key: item.key } as unknown as InventoryRow);
  };

  const onEvent = (event: ExplorerLiveEvent): void => {
    if (destroyed) return;
    switch (event.kind) {
      case 'snapshot': {
        const found = rowOf(event.items);
        snapshotSeen = true;
        if (found !== undefined) {
          row = found;
          removed = false;
          absent = false;
        } else {
          absent = true;
          if (row !== null) removed = true; // it was read before and is gone
        }
        store.set({ live: 'following' });
        settle();
        break;
      }
      case 'delta': {
        const upserted = rowOf(event.upserts);
        if (upserted !== undefined) {
          row = upserted;
          removed = false;
          absent = false;
        } else if (event.removes.includes(query.key)) {
          if (row !== null) removed = true;
          else absent = true;
        }
        settle();
        break;
      }
      case 'gap':
        store.set({ gaps: store.get().gaps + 1 }); // the snapshot that follows reconciles
        break;
      case 'reset':
        readFreshness(); // the engine started a new session: its versions restart
        break;
      case 'status':
        break;
      case 'error':
        store.set({ live: 'ended', problem: event.error });
        if (row === null) fatal = { error: event.error };
        settle();
        break;
      case 'end':
        store.set({ live: 'ended' });
        break;
    }
  };

  const stop = data.follow(
    { cid, kind: query.kind, keys: [query.key] },
    onEvent,
  );
  readFreshness();

  return {
    state: store.get,
    onState: store.subscribe,
    refresh() {
      if (!destroyed) readFreshness();
    },
    destroy() {
      destroyed = true;
      reading?.abort();
      stop();
    },
  };
}

/** A binding: found by its key over the windows of its vhost, once and again on `refresh()`. */
function watchBinding(data: ExplorerData, query: EntityQuery): EntityWatch {
  const store = makeStore({ ...INITIAL });
  const address = parseEntityPath(`/bindings/${query.key}`);
  const parts = address === null ? null : bindingParts(address.name);
  let destroyed = false;
  let reading: AbortController | null = null;

  const read = (): void => {
    reading?.abort();
    const controller = new AbortController();
    reading = controller;
    store.set({ reads: store.get().reads + 1 });
    if (address === null || parts === null) {
      store.set({
        phase: 'error',
        problem: new TypeError('The key is not the key of a binding.'),
      });
      return;
    }
    const hit: { row: InventoryRow | null } = { row: null };
    scanBindings(
      data,
      {
        cid: query.cid,
        vhost: address.vhost,
        text: parts.destination !== '' ? parts.destination : parts.source,
      },
      controller.signal,
      (candidate) => {
        if (candidate.key !== query.key) return false;
        hit.row = candidate;
        return true;
      },
    ).then(
      (scan) => {
        if (destroyed || controller.signal.aborted) return;
        const base = {
          freshness: scan.freshness,
          freshnessProblem: null,
        };
        if (hit.row !== null) {
          store.set({ ...base, phase: 'found', row: hit.row, problem: null });
        } else if (scan.problem !== null) {
          store.set({ ...base, phase: 'error', problem: scan.problem });
        } else {
          // Absent: certain only when every matching row was read and the index is whole.
          store.set({
            ...base,
            phase: 'missing',
            certain: !scan.truncated && isCertain(scan.freshness),
            row: null,
            problem: null,
          });
        }
      },
      (error: unknown) => {
        if (destroyed || controller.signal.aborted) return;
        store.set({ phase: 'error', problem: error });
      },
    );
  };
  read();

  return {
    state: store.get,
    onState: store.subscribe,
    refresh() {
      if (!destroyed) read();
    },
    destroy() {
      destroyed = true;
      reading?.abort();
    },
  };
}

/** Starts reading one entity. Call `destroy()` when the page goes away. */
export function createEntityWatch(
  data: ExplorerData,
  query: EntityQuery,
): EntityWatch {
  if (query.kind === 'bindings') return watchBinding(data, query);
  return watchFollowed(data, { ...query, kind: query.kind });
}

/**
 * Whether an entity exists, for the connection switcher (R4): `found`, `absent` (certain) or `unknown`
 * (loading, partial, an error, an abort). It reads once and releases everything before it answers.
 */
export function lookupEntity(
  data: ExplorerData,
  query: EntityQuery,
  signal: AbortSignal,
): Promise<'found' | 'absent' | 'unknown'> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve('unknown');
      return;
    }
    const watch = createEntityWatch(data, query);
    let stopListening: (() => void) | null = null;
    const finish = (answer: 'found' | 'absent' | 'unknown'): void => {
      stopListening?.();
      signal.removeEventListener('abort', onAbort);
      watch.destroy();
      resolve(answer);
    };
    const onAbort = (): void => {
      finish('unknown');
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const check = (state: EntityState): boolean => {
      if (state.phase === 'found' || state.phase === 'vanished') {
        finish('found');
      } else if (state.phase === 'missing') {
        finish(state.certain ? 'absent' : 'unknown');
      } else if (state.phase === 'error') {
        finish('unknown');
      } else {
        return false;
      }
      return true;
    };
    if (!check(watch.state())) stopListening = watch.onState(check);
  });
}
