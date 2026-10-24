import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { findDlxLoops } from './cycles.ts';
import { deadLetterPath } from './dlx.ts';
import { bind, deepFreeze, exchange, expiring, topologyOf } from './testing.ts';
import type { RoutingTopology } from './types.ts';

// A random dead-letter graph: queue i expires into its own direct exchange Xi with the fixed key
// "k", and Xi is bound to the queues in edges[i]. No queue is rejectable, so every death is
// automatic and the broker's rule reduces to "a queue that already died on this run is not
// delivered to again".
const graphs = fc.integer({ min: 1, max: 6 }).chain((n) =>
  fc.tuple(
    fc.constant(n),
    fc.array(
      fc.uniqueArray(fc.integer({ min: 0, max: n - 1 }), { maxLength: n }),
      {
        minLength: n,
        maxLength: n,
      },
    ),
  ),
);

function build(
  n: number,
  edges: readonly (readonly number[])[],
): RoutingTopology {
  const ids = Array.from({ length: n }, (_, i) => i);
  return topologyOf(
    ids.map((i) => exchange(`X${String(i)}`)),
    ids.map((i) => expiring(`Q${String(i)}`, `X${String(i)}`, 'k')),
    ids.flatMap((i) =>
      (edges[i] ?? []).map((j) => bind(`X${String(i)}`, `Q${String(j)}`, 'k')),
    ),
  );
}

/** The queues reachable from 0 by walking the edges; independent of the library. */
function reachableFrom0(
  n: number,
  edges: readonly (readonly number[])[],
): string[] {
  const seen = new Set<number>([0]);
  const todo = [0];
  for (const at of todo) {
    for (const next of edges[at] ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        todo.push(next);
      }
    }
  }
  expect(n).toBeGreaterThan(0);
  seen.delete(0); // the start is on its own run, so it is never delivered to again
  return [...seen].map((i) => `Q${String(i)}`).sort();
}

/** The cycles of the graph by brute force: nodes on a closed walk. */
function onCycle(
  n: number,
  edges: readonly (readonly number[])[],
): Set<number> {
  const out = new Set<number>();
  for (let start = 0; start < n; start += 1) {
    const seen = new Set<number>();
    const todo = [...(edges[start] ?? [])];
    for (const at of todo) {
      if (seen.has(at)) continue;
      seen.add(at);
      todo.push(...(edges[at] ?? []));
    }
    if (seen.has(start)) out.add(start);
  }
  return out;
}

describe('dead-letter properties', () => {
  it('M1-03 AC-9 dlx the queues reached equal an independent reachability oracle on random graphs', () => {
    fc.assert(
      fc.property(graphs, ([n, edges]) => {
        const result = deadLetterPath(build(n, edges), 'Q0');
        expect([...result.reached]).toEqual(reachableFrom0(n, edges));
        expect(result.exact).toBe(true);
        // Every path is a sequence of real edges, and no queue appears twice on one path.
        for (const path of result.paths) {
          const visited = path.steps.map((s) => s.from);
          expect(new Set(visited).size).toBe(visited.length);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('M1-03 AC-2 dlx the loops found are the strongly connected queues of the graph', () => {
    fc.assert(
      fc.property(graphs, ([n, edges]) => {
        const result = findDlxLoops(build(n, edges));
        const found = new Set(result.loops.flatMap((l) => l.queues));
        const expected = new Set(
          [...onCycle(n, edges)].map((i) => `Q${String(i)}`),
        );
        expect(found).toEqual(expected);
        for (const loop of result.loops) {
          expect(loop.kind).toBe('drop-loop');
          expect(loop.possible).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('M1-03 AC-11 dlx results are pure: a frozen input is not changed and the same input gives the same answer', () => {
    fc.assert(
      fc.property(graphs, ([n, edges]) => {
        const t = deepFreeze(build(n, edges));
        const first = deadLetterPath(t, 'Q0');
        const second = deadLetterPath(t, 'Q0');
        expect(second).toEqual(first);
        expect(findDlxLoops(t)).toEqual(findDlxLoops(t));
      }),
      { numRuns: 100 },
    );
  });

  it('M1-03 AC-11 dlx the reached set and the loops do not depend on the order of queues, exchanges and bindings', () => {
    fc.assert(
      fc.property(graphs, fc.infiniteStream(fc.nat()), ([n, edges], stream) => {
        const t = build(n, edges);
        const shuffle = <T>(items: readonly T[]): T[] => {
          const copy = [...items];
          const it = stream[Symbol.iterator]();
          for (let i = copy.length - 1; i > 0; i -= 1) {
            const j = it.next().value % (i + 1);
            const a = copy[i] as T;
            copy[i] = copy[j] as T;
            copy[j] = a;
          }
          return copy;
        };
        const shuffled: RoutingTopology = {
          exchanges: shuffle(t.exchanges),
          queues: shuffle(t.queues),
          bindings: shuffle(t.bindings),
        };
        expect(deadLetterPath(shuffled, 'Q0').reached).toEqual(
          deadLetterPath(t, 'Q0').reached,
        );
        expect(findDlxLoops(shuffled).loops).toEqual(findDlxLoops(t).loops);
      }),
      { numRuns: 100 },
    );
  });

  it('M1-03 AC-2 dlx a rejection anywhere in a ring turns the drop loop into a retry ring and keeps its queues reachable', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 6 }), fc.nat(), (n, pick) => {
        const ids = Array.from({ length: n }, (_, i) => i);
        const rejecting = pick % n;
        const t = topologyOf(
          ids.map((i) => exchange(`X${String(i)}`)),
          ids.map((i) =>
            expiring(`Q${String(i)}`, `X${String(i)}`, 'k', {
              rejectable: i === rejecting,
            }),
          ),
          ids.map((i) => bind(`X${String(i)}`, `Q${String((i + 1) % n)}`, 'k')),
        );
        const loops = findDlxLoops(t).loops;
        expect(loops).toHaveLength(1);
        expect(loops[0]?.kind).toBe('retry-ring');
        // A message rejected at the rejecting queue gets all the way round.
        const rejected = deadLetterPath(t, `Q${String(rejecting)}`, {
          reason: 'rejected',
        });
        expect(rejected.reached).toContain(`Q${String(rejecting)}`);
        expect(rejected.reached).toHaveLength(n);
      }),
      { numRuns: 50 },
    );
  });
});
