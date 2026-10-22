// The session behind a page of charts (M1-54, R2, R3). It follows `metrics.live` first, buffers what arrives, reads
// `metrics.query` for the history, joins the two by time without a seam or a duplicate, then keeps following. Every
// series has a bounded ring (R2); a series the engine does not hold is `not-reported`, never zero; a gap or a reset
// of the live protocol asks for the history again once; pausing freezes what the page shows while the rings keep
// receiving; nothing here polls or keeps a timer, and the page redraws on the events it is given.
import {
  ConnectionIdSchema,
  METRICS_STATUS_KEY,
  SERIES_QUERY_MAX,
} from '@app/contracts';

import type {
  LiveFeedEvent,
  LiveItem,
  MetricsData,
  MetricsStatus,
  QueueRef,
  SeriesRef,
  SeriesResult,
} from './ports';
import { refKey } from './series-key';
import { SeriesRing, type RingPoint } from './series-ring';

/** What one history read asks for per series: the whole hot window is at most this many points. */
export const HISTORY_MAX_POINTS = 720;
/** The summary of the live region changes at most this often, in data time, unless the state changes. */
export const SUMMARY_EVERY_MS = 15_000;

export interface SessionConfig {
  readonly cid: string;
  /** The series to chart: at most 50, the engine's query limit (more are ignored). */
  readonly series: readonly SeriesRef[];
  /** The queues the live subscription asks the engine to collect; default: the queues of `series`. */
  readonly queues?: readonly QueueRef[];
}

/** `pending` until the history was answered; `not-reported` when the engine holds no such series (no points, never zero). */
export type SeriesState = 'pending' | 'drawn' | 'not-reported';

export interface SeriesView {
  readonly ref: SeriesRef;
  readonly key: string;
  readonly state: SeriesState;
  readonly kind: 'gauge' | 'counter' | undefined;
  readonly unit: 'messages' | 'count' | 'bytes' | undefined;
  readonly source: 'prometheus' | 'management' | undefined;
  /** The values come from management sampling: coarse. */
  readonly approximate: boolean;
  /** Raw values, oldest first: a counter is a counter (`counterRate` turns it into a rate). */
  readonly points: readonly RingPoint[];
  /** Points this ring pushed out when it was full (counted, I-13). */
  readonly evicted: number;
  /** Points the engine's own ring has evicted since it began. */
  readonly engineDropped: number;
}

export type SessionPhase = 'loading' | 'ready' | 'empty' | 'error';
export type LiveState = 'connecting' | 'following' | 'ended';

/** What the throttled summary of the live region is made of: newest values and the states that matter. */
export interface SummaryFacts {
  readonly t: number | null;
  readonly values: Readonly<Record<string, number>>;
  readonly phase: SessionPhase;
  readonly live: LiveState;
  readonly paused: boolean;
  readonly statusState: MetricsStatus['state'] | null;
}

export interface SessionState {
  readonly phase: SessionPhase;
  readonly series: readonly SeriesView[];
  /** The newest status of the engine (from the history read or the live topic); `null` before either. */
  readonly status: MetricsStatus | null;
  /** The failure of the history read, as received; `null` when it worked. The live part may still work. */
  readonly problem: unknown;
  readonly live: LiveState;
  /** What ended the live topic, as received; `null` when it ended without one or has not ended. */
  readonly liveProblem: unknown;
  readonly paused: boolean;
  /** Points received while paused, not shown yet. */
  readonly waiting: number;
  /** Gaps and resets of the live protocol seen (each asked for the history again). */
  readonly gaps: number;
  /** History reads started. */
  readonly historyReads: number;
  /** The time of the newest point of any series. */
  readonly newestT: number | null;
  readonly summary: SummaryFacts;
}

export interface MetricsSession {
  state(): SessionState;
  onState(listener: (state: SessionState) => void): () => void;
  pause(): void;
  resume(): void;
  /** Reads the history again (after a failure, or when the person asks). */
  reload(): void;
  /** Aborts what is in flight and ends the subscription. */
  destroy(): void;
}

interface Meta {
  readonly ref: SeriesRef;
  found: boolean | undefined;
  kind: SeriesView['kind'];
  unit: SeriesView['unit'];
  source: SeriesView['source'];
  approximate: boolean;
  engineDropped: number;
}

export function createMetricsSession(
  data: MetricsData,
  config: SessionConfig,
): MetricsSession {
  const cid = ConnectionIdSchema.parse(config.cid);
  const refs: SeriesRef[] = [];
  const rings = new Map<string, SeriesRing>();
  const metas = new Map<string, Meta>();
  for (const ref of config.series) {
    const key = refKey(ref);
    if (metas.has(key) || refs.length >= SERIES_QUERY_MAX) continue;
    refs.push(ref);
    rings.set(key, new SeriesRing());
    metas.set(key, {
      ref,
      found: undefined,
      kind: undefined,
      unit: undefined,
      source: undefined,
      approximate: false,
      engineDropped: 0,
    });
  }
  const queues =
    config.queues ??
    refs.flatMap((ref) => (ref.queue === undefined ? [] : [ref.queue]));

  const listeners = new Set<(state: SessionState) => void>();
  const views = new Map<string, SeriesView>();
  /** The newest live item per series while the first history read is in flight. */
  const pendingLive = new Map<string, LiveItem>();
  let status: MetricsStatus | null = null;
  /** The live topic's status is newer than the history read's: the history does not overwrite it. */
  let liveStatus = false;
  let problem: unknown = null;
  let live: LiveState = 'connecting';
  let liveProblem: unknown = null;
  let paused = false;
  let frozen: readonly SeriesView[] | null = null;
  let waiting = 0;
  let gaps = 0;
  let historyReads = 0;
  let answered = false;
  let loading = false;
  let again = false;
  let newestT: number | null = null;
  let destroyed = false;
  let reading: AbortController | null = null;
  let summary: SummaryFacts = {
    t: null,
    values: {},
    phase: 'loading',
    live: 'connecting',
    paused: false,
    statusState: null,
  };
  let state: SessionState;

  const viewOf = (key: string): SeriesView => {
    const cached = views.get(key);
    if (cached !== undefined) return cached;
    const ring = rings.get(key);
    const meta = metas.get(key);
    if (ring === undefined || meta === undefined) {
      throw new Error('a series of the session has no ring');
    }
    const points = ring.points();
    const view: SeriesView = {
      ref: meta.ref,
      key,
      state:
        points.length > 0
          ? 'drawn'
          : meta.found === undefined
            ? 'pending'
            : 'not-reported',
      kind: meta.kind,
      unit: meta.unit,
      source: meta.source,
      approximate: meta.approximate,
      points,
      evicted: ring.stats.evicted,
      engineDropped: meta.engineDropped,
    };
    views.set(key, view);
    return view;
  };

  const phaseOf = (series: readonly SeriesView[]): SessionPhase => {
    if (series.some((s) => s.state === 'drawn')) return 'ready';
    if (!answered) return 'loading';
    return problem === null ? 'empty' : 'error';
  };

  /** The summary changes when a state that matters changes, or after 15 s of data time. */
  const summarise = (
    series: readonly SeriesView[],
    phase: SessionPhase,
  ): void => {
    const statusState = status?.state ?? null;
    const changed =
      summary.phase !== phase ||
      summary.live !== live ||
      summary.paused !== paused ||
      summary.statusState !== statusState;
    const due =
      newestT !== null &&
      (summary.t === null || newestT - summary.t >= SUMMARY_EVERY_MS);
    if (!changed && !due) return;
    const values: Record<string, number> = {};
    for (const view of series) {
      const last = view.points[view.points.length - 1];
      if (last !== undefined) values[view.key] = last.v;
    }
    summary = { t: newestT, values, phase, live, paused, statusState };
  };

  const build = (): SessionState => {
    const series = frozen ?? [...rings.keys()].map(viewOf);
    const phase = phaseOf(series);
    summarise(series, phase);
    return {
      phase,
      series,
      status,
      problem,
      live,
      liveProblem,
      paused,
      waiting,
      gaps,
      historyReads,
      newestT,
      summary,
    };
  };

  const emit = (): void => {
    state = build();
    for (const listener of listeners) listener(state);
  };

  const touch = (key: string): void => {
    views.delete(key);
  };

  const applyItem = (item: LiveItem): boolean => {
    if (item.key === METRICS_STATUS_KEY) {
      if (item.status !== undefined) {
        status = item.status;
        liveStatus = true;
      }
      return true;
    }
    if (
      item.ref === undefined ||
      item.t === undefined ||
      item.v === undefined
    ) {
      return false;
    }
    const key = refKey(item.ref);
    const ring = rings.get(key);
    const meta = metas.get(key);
    if (ring === undefined || meta === undefined) return false;
    if (item.approximate !== undefined) meta.approximate = item.approximate;
    if (ring.push(item.t, item.v) === 'kept') {
      newestT = newestT === null ? item.t : Math.max(newestT, item.t);
      if (paused) waiting += 1;
      touch(key);
    }
    return true;
  };

  const handle = (items: readonly LiveItem[]): void => {
    for (const item of items) {
      if (!answered && item.key !== METRICS_STATUS_KEY) {
        // Until the history is in, only the newest item of a series is kept: the history covers the rest.
        const held = pendingLive.get(item.key);
        if (held === undefined || (item.t ?? 0) >= (held.t ?? 0)) {
          pendingLive.set(item.key, item);
        }
      } else {
        applyItem(item);
      }
    }
  };

  const merge = (result: SeriesResult): void => {
    const key = refKey(result.ref);
    const ring = rings.get(key);
    const meta = metas.get(key);
    if (ring === undefined || meta === undefined) return;
    meta.found = result.found;
    meta.kind = result.kind;
    meta.unit = result.unit;
    meta.source = result.source;
    meta.approximate = result.approximate === true;
    meta.engineDropped = result.dropped;
    if (!result.found) {
      touch(key);
      return;
    }
    // The history replaces what the ring holds, except the live points newer than it.
    const newestHistory =
      result.points[result.points.length - 1]?.[0] ?? -Infinity;
    const live = ring.points().filter((p) => p.t > newestHistory);
    ring.clear();
    for (const [t, v] of result.points) ring.push(t, v);
    for (const p of live) ring.push(p.t, p.v);
    const last = ring.last();
    if (last !== undefined) {
      newestT = newestT === null ? last.t : Math.max(newestT, last.t);
    }
    touch(key);
  };

  const wantsAgain = (): boolean => again;
  const isDestroyed = (): boolean => destroyed;

  const loadHistory = async (): Promise<void> => {
    reading?.abort();
    const controller = new AbortController();
    reading = controller;
    historyReads += 1;
    loading = true;
    again = false;
    try {
      const out = await data.query(
        { cid, series: refs, maxPoints: HISTORY_MAX_POINTS, rate: false },
        controller.signal,
      );
      if (controller.signal.aborted || destroyed) return;
      if (!liveStatus) status = out.status;
      for (const result of out.series) merge(result);
      problem = null;
    } catch (error) {
      if (controller.signal.aborted || destroyed) return;
      problem = error;
    }
    loading = false;
    answered = true;
    const buffered = [...pendingLive.values()];
    pendingLive.clear();
    for (const item of buffered) applyItem(item);
    emit();
    // Read through a function: the flags change while the read is awaited, which the compiler cannot see.
    if (wantsAgain() && !isDestroyed()) void loadHistory();
  };

  const reloadSoon = (): void => {
    if (loading) again = true;
    else void loadHistory();
  };

  const unfollow = data.follow(
    { cid, queues: [...queues] },
    (event: LiveFeedEvent) => {
      if (destroyed) return;
      switch (event.kind) {
        case 'snapshot':
          live = 'following';
          handle(event.items);
          break;
        case 'delta':
          live = 'following';
          handle(event.upserts);
          break;
        case 'gap':
          gaps += 1;
          reloadSoon();
          break;
        case 'reset':
          gaps += 1;
          live = 'connecting';
          reloadSoon();
          break;
        case 'status':
          return;
        case 'error':
          live = 'ended';
          liveProblem = event.error;
          break;
        case 'end':
          live = 'ended';
          break;
      }
      emit();
    },
  );

  state = build();
  void loadHistory();
  emit();

  return {
    state: () => state,
    onState(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    pause() {
      if (paused || destroyed) return;
      frozen = state.series;
      paused = true;
      waiting = 0;
      emit();
    },
    resume() {
      if (!paused || destroyed) return;
      paused = false;
      frozen = null;
      waiting = 0;
      emit();
    },
    reload() {
      if (destroyed) return;
      void loadHistory();
      emit();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      reading?.abort();
      unfollow();
      listeners.clear();
    },
  };
}
