import type {
  EngineWindowSource,
  GridRowChange,
  GridSort,
  GridWindow,
  GridWindowRequest,
} from '../window-source';

export interface FakeRow {
  readonly id: string;
  readonly index: number;
  readonly name: string;
}

export interface FakeWindowSourceOptions {
  readonly rows?: number; // default 100,000
  /** Wait before answering; the wait ends early when the request is aborted. */
  readonly latencyMs?: number;
  /** Reject the request for this offset. */
  readonly failAt?: (offset: number) => boolean;
  /** Answer with this many rows for every request, whatever the limit (an oversized answer). */
  readonly oversizeBy?: number;
  /** Report `total: null` while the window does not reach the end. */
  readonly unknownTotal?: boolean;
  /** Answer even after an abort (a late answer). */
  readonly ignoreAbort?: boolean;
}

export interface FakeWindowSource extends EngineWindowSource<FakeRow> {
  readonly requests: readonly GridWindowRequest[];
  readonly watched: readonly ReadonlySet<string>[];
  emit(changes: readonly GridRowChange<FakeRow>[]): void;
}

export function fakeRow(index: number): FakeRow {
  return { id: `row-${String(index)}`, index, name: `queue-${String(index)}` };
}

/** A deterministic engine window: `rows` rows, sorted by index or by name. */
export function createFakeWindowSource(
  options: FakeWindowSourceOptions = {},
): FakeWindowSource {
  const count = options.rows ?? 100_000;
  const requests: GridWindowRequest[] = [];
  const watched: ReadonlySet<string>[] = [];
  const listeners = new Set<
    (changes: readonly GridRowChange<FakeRow>[]) => void
  >();
  return {
    requests,
    watched,
    rowId: (row) => row.id,
    async window(request, signal): Promise<GridWindow<FakeRow>> {
      requests.push(request);
      if (options.latencyMs)
        await wait(options.latencyMs, options.ignoreAbort ? undefined : signal);
      if (options.failAt?.(request.offset))
        throw new Error(`fake failure at ${String(request.offset)}`);
      const size = request.limit + (options.oversizeBy ?? 0);
      const rows: FakeRow[] = [];
      for (
        let i = request.offset;
        i < Math.min(count, request.offset + size);
        i++
      ) {
        rows.push(fakeRow(sorted(i, request.sort, count)));
      }
      const reachesEnd = request.offset + request.limit >= count;
      return {
        rows,
        total: options.unknownTotal && !reachesEnd ? null : count,
      };
    },
    watch: (ids) => void watched.push(ids),
    onChanges(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    emit(changes) {
      for (const l of listeners) l(changes);
    },
  };
}

function sorted(
  position: number,
  sort: readonly GridSort[],
  count: number,
): number {
  return sort[0]?.direction === 'desc' ? count - 1 - position : position;
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    });
  });
}
