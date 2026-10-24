// The graph of a vhost, and the neighbourhood of one object, held to a fixed number of elements
// (spec R4). Pure over the routing library's topology: no clock, no randomness, same input and same
// output. When the scope does not fit, the nodes are ranked (the focus, then distance, then degree,
// then kind and name), the largest prefix whose answer fits is kept, and every other node is folded
// into an aggregate node with a count and a few names. Nothing is dropped without being counted
// (I-13). The work runs in turns of the event loop (I-5).
import { AGGREGATE_SAMPLE_MAX } from '@app/contracts';
import type { GraphEdge, GraphNode, TopologyGraph } from '@app/contracts';
import type { RoutingTopology } from '@app/routing';

import { sortCooperative, ticker, type YieldNow } from './cooperative';

export interface GraphRequest {
  /** Absent: the whole vhost. */
  readonly focus?: {
    readonly kind: 'exchange' | 'queue';
    readonly name: string;
  };
  /** Hops from the focus; ignored without one. */
  readonly depth: 0 | 1 | 2;
  /** Nodes plus edges, at most. */
  readonly maxElements: number;
  /** Items handled between two turns of the event loop. */
  readonly every: number;
  readonly yieldNow: YieldNow;
}

export type GraphResult =
  | { readonly kind: 'ok'; readonly graph: TopologyGraph }
  | { readonly kind: 'focus-not-found' };

type EdgeKind = 'binding' | 'alternate-exchange' | 'dead-letter';

/** A number at an index, 0 outside: the arrays below are filled before they are read. */
const at = (list: ArrayLike<number>, index: number): number => list[index] ?? 0;

const compareText = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;
const byName = (a: { name: string }, b: { name: string }): number =>
  compareText(a.name, b.name);

export async function buildGraph(
  topology: RoutingTopology,
  request: GraphRequest,
): Promise<GraphResult> {
  const { every, yieldNow } = request;
  const tick = ticker(every, yieldNow);

  // Nodes: the exchanges (not the default one, which every queue is implicitly bound to) and then
  // the queues, each sorted by name, so the index of a node orders by kind and name.
  const exchanges = await sortCooperative(
    topology.exchanges.filter((x) => x.name !== ''),
    byName,
    every,
    yieldNow,
  );
  const queues = await sortCooperative(
    topology.queues,
    byName,
    every,
    yieldNow,
  );
  const X = exchanges.length;
  const N = X + queues.length;
  const exchangeAt = new Map<string, number>();
  const queueAt = new Map<string, number>();
  for (const [i, x] of exchanges.entries()) exchangeAt.set(x.name, i);
  for (const [i, q] of queues.entries()) queueAt.set(q.name, X + i);
  const nameOf = (n: number): string =>
    (n < X ? exchanges[n]?.name : queues[n - X]?.name) ?? '';
  const idOf = (n: number): string => `${n < X ? 'x' : 'q'}:${nameOf(n)}`;

  // Edges: one per binding, per alternate-exchange link and per dead-letter link.
  const eFrom: number[] = [];
  const eTo: number[] = [];
  const eKind: EdgeKind[] = [];
  const eLabel: (string | null)[] = [];
  let bindings = 0;
  let links = 0;
  let unrepresented = 0;
  const add = (
    from: number,
    to: number,
    kind: EdgeKind,
    label: string | null,
  ): void => {
    eFrom.push(from);
    eTo.push(to);
    eKind.push(kind);
    eLabel.push(label);
  };
  for (const binding of topology.bindings) {
    await tick();
    const from = exchangeAt.get(binding.source);
    const to =
      binding.destinationType === 'queue'
        ? queueAt.get(binding.destination)
        : exchangeAt.get(binding.destination);
    if (from === undefined || to === undefined) {
      unrepresented += 1;
      continue;
    }
    add(from, to, 'binding', binding.routingKey);
    bindings += 1;
  }
  for (const [i, exchange] of exchanges.entries()) {
    await tick();
    const ae = exchange.alternateExchange;
    if (typeof ae !== 'string') continue;
    const to = exchangeAt.get(ae);
    if (to === undefined) unrepresented += 1;
    else {
      add(i, to, 'alternate-exchange', null);
      links += 1;
    }
  }
  for (const [i, queue] of queues.entries()) {
    await tick();
    if (queue.deadLetter?.status !== 'set') continue;
    const to = exchangeAt.get(queue.deadLetter.exchange);
    if (to === undefined) unrepresented += 1;
    else {
      add(X + i, to, 'dead-letter', queue.deadLetter.routingKey ?? null);
      links += 1;
    }
  }
  const E = eFrom.length;

  // Adjacency over the undirected edges: the edge indices of node n are adj[start[n] .. start[n+1]).
  const start = new Int32Array(N + 1);
  for (const n of [...eFrom, ...eTo]) start[n + 1] = at(start, n + 1) + 1;
  for (let n = 0; n < N; n++) start[n + 1] = at(start, n + 1) + at(start, n);
  const fill = start.slice(0, N);
  const adj = new Int32Array(2 * E);
  for (let e = 0; e < E; e++) {
    await tick();
    for (const n of [at(eFrom, e), at(eTo, e)]) {
      adj[at(fill, n)] = e;
      fill[n] = at(fill, n) + 1;
    }
  }
  const other = (e: number, n: number): number =>
    at(eFrom, e) === n ? at(eTo, e) : at(eFrom, e);
  const edgesOf = (n: number): Int32Array =>
    adj.subarray(at(start, n), at(start, n + 1));

  // The scope: the whole vhost, or the nodes within `depth` hops of the focus.
  const inScope = new Uint8Array(N);
  const dist = new Int32Array(N);
  const scope: number[] = [];
  if (request.focus === undefined) {
    for (let n = 0; n < N; n++) {
      inScope[n] = 1;
      scope.push(n);
    }
  } else {
    const found =
      request.focus.kind === 'exchange'
        ? exchangeAt.get(request.focus.name)
        : queueAt.get(request.focus.name);
    if (found === undefined) return { kind: 'focus-not-found' };
    inScope[found] = 1;
    scope.push(found);
    for (let head = 0; head < scope.length; head++) {
      const n = at(scope, head);
      if (at(dist, n) >= request.depth) continue;
      for (const e of edgesOf(n)) {
        await tick();
        const o = other(e, n);
        if (at(inScope, o) === 1) continue;
        inScope[o] = 1;
        dist[o] = at(dist, n) + 1;
        scope.push(o);
      }
    }
  }
  const scopeEdges: number[] = [];
  for (let e = 0; e < E; e++) {
    await tick();
    if (at(inScope, at(eFrom, e)) === 1 && at(inScope, at(eTo, e)) === 1) {
      scopeEdges.push(e);
    }
  }

  // Which nodes are shown one by one: all of the scope when it fits, else a ranked prefix.
  const rank = new Int32Array(N).fill(-1);
  let order: number[] = scope;
  let shown = scope.length;
  const fits = scope.length + scopeEdges.length <= request.maxElements;
  // Edge groups: one per edge when everything fits; otherwise parallel edges (the same ends and the
  // same kind, for example several routing keys between an exchange and a queue) are merged into one
  // edge that counts them, so that a node with very many bindings to one neighbour can still be shown.
  interface EdgeGroup {
    from: number;
    to: number;
    kind: EdgeKind;
    label: string | null;
    count: number;
  }
  const edgeGroups: EdgeGroup[] = [];
  const groupAt = new Map<number, number>();
  for (const e of scopeEdges) {
    await tick();
    const group: EdgeGroup = {
      from: at(eFrom, e),
      to: at(eTo, e),
      kind: eKind[e] ?? 'binding',
      label: eLabel[e] ?? null,
      count: 1,
    };
    if (fits) {
      edgeGroups.push(group);
      continue;
    }
    const key =
      (group.from * N + group.to) * 3 +
      (group.kind === 'binding'
        ? 0
        : group.kind === 'alternate-exchange'
          ? 1
          : 2);
    const found = groupAt.get(key);
    const merged = found === undefined ? undefined : edgeGroups[found];
    if (merged === undefined) {
      groupAt.set(key, edgeGroups.length);
      edgeGroups.push(group);
    } else {
      merged.count += 1;
      merged.label = null;
    }
  }
  /** The best-ranked shown neighbour of a dropped node, or -1. */
  const anchorOf = (n: number, k: number): number => {
    let anchor = -1;
    for (const e of edgesOf(n)) {
      const o = other(e, n);
      const r = at(rank, o);
      if (r >= 0 && r < k && (anchor === -1 || r < at(rank, anchor))) {
        anchor = o;
      }
    }
    return anchor;
  };
  if (!fits) {
    const degree = new Int32Array(N);
    for (const e of scopeEdges) {
      degree[at(eFrom, e)] = at(degree, at(eFrom, e)) + 1;
      degree[at(eTo, e)] = at(degree, at(eTo, e)) + 1;
    }
    order = await sortCooperative(
      scope,
      (a, b) =>
        at(dist, a) - at(dist, b) || at(degree, b) - at(degree, a) || a - b,
      every,
      yieldNow,
    );
    for (const [i, n] of order.entries()) rank[n] = i;
    /** Nodes plus edges plus aggregates of the answer that shows the first `k` nodes. */
    const elementsFor = async (k: number): Promise<number> => {
      let keptEdges = 0;
      for (const group of edgeGroups) {
        await tick();
        if (at(rank, group.from) < k && at(rank, group.to) < k) keptEdges += 1;
      }
      const groups = new Set<number>();
      for (const n of order.slice(k)) {
        await tick();
        groups.add((n < X ? 0 : 1) + 2 * (anchorOf(n, k) + 1));
      }
      let anchored = 0;
      for (const key of groups) if (key >= 2) anchored += 1;
      return k + keptEdges + groups.size + anchored;
    };
    let low = 0;
    let high = order.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if ((await elementsFor(mid)) <= request.maxElements) low = mid;
      else high = mid - 1;
    }
    // `low` only ever takes a prefix that fits, so the answer fits whether or not the count is monotone.
    shown = low;
  }
  const isShown = (n: number): boolean =>
    fits ? at(inScope, n) === 1 : at(rank, n) >= 0 && at(rank, n) < shown;

  // The answer.
  const nodes: GraphNode[] = [];
  const shownNodes = (fits ? scope : order.slice(0, shown))
    .slice()
    .sort((a, b) => a - b);
  for (const n of shownNodes) {
    await tick();
    const hasMore = edgesOf(n).some((e) => {
      const o = other(e, n);
      return o !== n && !isShown(o);
    });
    if (n < X) {
      nodes.push({
        id: idOf(n),
        kind: 'exchange',
        name: nameOf(n),
        type: exchanges[n]?.type ?? '',
        internal: exchanges[n]?.internal === true,
        hasMore,
      });
    } else {
      nodes.push({
        id: idOf(n),
        kind: 'queue',
        name: nameOf(n),
        type: queues[n - X]?.type ?? null,
        hasMore,
      });
    }
  }
  const drafts: Omit<GraphEdge, 'id'>[] = [];
  let shownEdges = 0;
  for (const group of edgeGroups) {
    await tick();
    if (isShown(group.from) && isShown(group.to)) {
      shownEdges += group.count;
      drafts.push({
        from: idOf(group.from),
        to: idOf(group.to),
        kind: group.kind,
        label: group.label,
        count: group.count,
      });
    }
  }
  if (!fits) {
    const groups = new Map<
      string,
      { of: 'exchange' | 'queue'; via: number; names: string[]; edges: number }
    >();
    for (const n of order.slice(shown)) {
      await tick();
      const anchor = anchorOf(n, shown);
      const of = n < X ? 'exchange' : 'queue';
      const key = `${of}:${anchor < 0 ? '-' : idOf(anchor)}`;
      const group = groups.get(key) ?? { of, via: anchor, names: [], edges: 0 };
      groups.set(key, group);
      group.names.push(nameOf(n));
      if (anchor >= 0) {
        group.edges += edgesOf(n).filter((e) => other(e, n) === anchor).length;
      }
    }
    for (const [key, group] of groups) {
      const id = `agg:${key}`;
      const via = group.via < 0 ? null : idOf(group.via);
      nodes.push({
        id,
        kind: 'aggregate',
        of: group.of,
        count: group.names.length,
        sample: group.names.sort(compareText).slice(0, AGGREGATE_SAMPLE_MAX),
        via,
      });
      if (via !== null) {
        drafts.push({
          from: via,
          to: id,
          kind: 'aggregate',
          label: null,
          count: Math.max(1, group.edges),
        });
      }
    }
  }
  // Aggregates last, the rest in the order of the ids; the same edges get the same ids every time.
  const group = (node: GraphNode): number =>
    node.kind === 'exchange' ? 0 : node.kind === 'queue' ? 1 : 2;
  nodes.sort((a, b) => group(a) - group(b) || compareText(a.id, b.id));
  drafts.sort(
    (a, b) =>
      compareText(a.from, b.from) ||
      compareText(a.to, b.to) ||
      compareText(a.kind, b.kind) ||
      compareText(a.label ?? '', b.label ?? ''),
  );
  const seen = new Map<string, number>();
  const edges: GraphEdge[] = drafts.map((draft) => {
    const base = `${draft.kind}:${draft.from}>${draft.to}:${draft.label ?? ''}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { id: `${base}#${String(n)}`, ...draft };
  });
  return {
    kind: 'ok',
    graph: {
      nodes,
      edges,
      elements: nodes.length + edges.length,
      // Anything folded into an aggregate node, or any parallel edges merged into one that counts them.
      aggregated: !fits,
      omitted: {
        nodes: scope.length - shownNodes.length,
        edges: scopeEdges.length - shownEdges,
      },
      scope: { nodes: scope.length, edges: scopeEdges.length },
      totals: {
        exchanges: X,
        queues: queues.length,
        bindings,
        links,
        unrepresented,
      },
      focus: request.focus === undefined ? null : { ...request.focus },
      depth: request.focus === undefined ? null : request.depth,
    },
  };
}
