import type { GraphNode, TopologyGraph } from '@app/contracts';
import type {
  RoutingTopology,
  TopologyBinding,
  TopologyExchange,
  TopologyQueue,
} from '@app/routing';
import { describe, expect, it } from 'vitest';

import { buildGraph, type GraphRequest } from './graph';

const x = (
  name: string,
  extra: Partial<TopologyExchange> = {},
): TopologyExchange => ({ name, type: 'direct', ...extra });
const q = (
  name: string,
  extra: Partial<TopologyQueue> = {},
): TopologyQueue => ({
  name,
  ...extra,
});
const bind = (
  source: string,
  destination: string,
  routingKey = '',
  destinationType: 'queue' | 'exchange' = 'queue',
): TopologyBinding => ({ source, destination, destinationType, routingKey });

const request = (over: Partial<GraphRequest> = {}): GraphRequest => ({
  depth: 1,
  maxElements: 2_000,
  every: 100,
  yieldNow: () => Promise.resolve(),
  ...over,
});
async function graphOf(
  topology: RoutingTopology,
  over: Partial<GraphRequest> = {},
): Promise<TopologyGraph> {
  const result = await buildGraph(topology, request(over));
  if (result.kind !== 'ok') throw new Error('the focus was not found');
  return result.graph;
}
const ids = (nodes: readonly GraphNode[]) => nodes.map((n) => n.id);

/** A deterministic generator, so a failure names its seed. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomTopology(seed: number): RoutingTopology {
  const next = random(seed);
  const pick = (n: number) => Math.floor(next() * n);
  const exchangeCount = 1 + pick(12);
  const queueCount = pick(60);
  const exchanges = Array.from({ length: exchangeCount }, (_, i) =>
    x(
      `x${String(i)}`,
      next() < 0.2
        ? { alternateExchange: `x${String(pick(exchangeCount))}` }
        : {},
    ),
  );
  const queues = Array.from({ length: queueCount }, (_, i) =>
    q(
      `q${String(i)}`,
      next() < 0.3
        ? {
            deadLetter: {
              status: 'set',
              exchange: `x${String(pick(exchangeCount))}`,
            },
          }
        : {},
    ),
  );
  const bindings = Array.from({ length: pick(150) }, () =>
    next() < 0.8 && queueCount > 0
      ? bind(
          `x${String(pick(exchangeCount))}`,
          `q${String(pick(queueCount))}`,
          `k${String(pick(5))}`,
        )
      : bind(
          `x${String(pick(exchangeCount))}`,
          `x${String(pick(exchangeCount))}`,
          '',
          'exchange',
        ),
  );
  return { exchanges, queues, bindings };
}

const small: RoutingTopology = {
  exchanges: [
    x('orders', { type: 'topic', alternateExchange: 'unrouted' }),
    x('orders.dlx', { type: 'fanout' }),
    x('unrouted', { type: 'fanout', internal: true }),
  ],
  queues: [
    q('orders.q', {
      type: 'quorum',
      deadLetter: { status: 'set', exchange: 'orders.dlx' },
    }),
    q('orders.dlq', { type: 'quorum' }),
    q('lost', { deadLetter: { status: 'set', exchange: 'gone' } }),
  ],
  bindings: [
    bind('orders', 'orders.q', 'order.*'),
    bind('orders.dlx', 'orders.dlq'),
    bind('', 'orders.q', 'orders.q'),
    bind('orders', 'ghost', 'x'),
  ],
};

describe('M1-20 AC-2 graph is whole when it fits and aggregated when it does not', () => {
  it('shows every node and edge of a small vhost, with the three kinds of edge', async () => {
    const graph = await graphOf(small);

    expect(ids(graph.nodes)).toEqual([
      'x:orders',
      'x:orders.dlx',
      'x:unrouted',
      'q:lost',
      'q:orders.dlq',
      'q:orders.q',
    ]);
    expect(graph.edges.map((e) => [e.kind, e.from, e.to, e.label])).toEqual([
      ['dead-letter', 'q:orders.q', 'x:orders.dlx', null],
      ['binding', 'x:orders', 'q:orders.q', 'order.*'],
      ['alternate-exchange', 'x:orders', 'x:unrouted', null],
      ['binding', 'x:orders.dlx', 'q:orders.dlq', ''],
    ]);
    expect(graph).toMatchObject({
      elements: 10,
      aggregated: false,
      omitted: { nodes: 0, edges: 0 },
      scope: { nodes: 6, edges: 4 },
      focus: null,
      depth: null,
      // Two bindings (default exchange, missing queue) and one link (missing exchange) are not drawn.
      totals: {
        exchanges: 3,
        queues: 3,
        bindings: 2,
        links: 2,
        unrepresented: 3,
      },
    });
    expect(graph.nodes.every((n) => n.kind === 'aggregate' || !n.hasMore)).toBe(
      true,
    );
    expect(graph.nodes.find((n) => n.id === 'x:unrouted')).toMatchObject({
      internal: true,
    });
    expect(graph.nodes.find((n) => n.id === 'q:orders.q')).toMatchObject({
      type: 'quorum',
    });
  });

  it('gives two bindings between the same objects an edge each, with ids that differ', async () => {
    const graph = await graphOf({
      exchanges: [x('e')],
      queues: [q('a')],
      bindings: [bind('e', 'a', 'k'), bind('e', 'a', 'k'), bind('e', 'a', 'j')],
    });

    expect(graph.edges.map((e) => e.id)).toEqual([
      'binding:x:e>q:a:j#1',
      'binding:x:e>q:a:k#1',
      'binding:x:e>q:a:k#2',
    ]);
  });

  it('is the same graph whatever the order of the input', async () => {
    const shuffled: RoutingTopology = {
      exchanges: [...small.exchanges].reverse(),
      queues: [...small.queues].reverse(),
      bindings: [...small.bindings].reverse(),
    };

    expect(await graphOf(shuffled)).toEqual(await graphOf(small));
  });

  it('folds a vhost larger than the cap into aggregates and still counts everything', async () => {
    const queues = Array.from({ length: 1_800 }, (_, i) =>
      q(`q-${String(i).padStart(4, '0')}`),
    );
    const topology: RoutingTopology = {
      exchanges: [x('fan', { type: 'fanout' }), x('other')],
      queues,
      bindings: queues.map((queue) => bind('fan', queue.name)),
    };

    const graph = await graphOf(topology, { maxElements: 100 });

    expect(graph.elements).toBeLessThanOrEqual(100);
    expect(graph.aggregated).toBe(true);
    expect(graph.totals).toMatchObject({
      exchanges: 2,
      queues: 1_800,
      bindings: 1_800,
    });
    const aggregate = graph.nodes.find(
      (n) => n.kind === 'aggregate' && n.of === 'queue',
    );
    expect(aggregate).toMatchObject({ of: 'queue', via: 'x:fan' });
    expect(aggregate?.kind === 'aggregate' && aggregate.sample).toHaveLength(5);
    // Every queue is shown or counted in an aggregate; so is every other object of the vhost.
    const shown = graph.nodes.filter((n) => n.kind === 'queue').length;
    const foldedQueues = graph.nodes.reduce(
      (sum, n) =>
        sum + (n.kind === 'aggregate' && n.of === 'queue' ? n.count : 0),
      0,
    );
    expect(shown + foldedQueues).toBe(1_800);
    const folded = graph.nodes.reduce(
      (sum, n) => sum + (n.kind === 'aggregate' ? n.count : 0),
      0,
    );
    expect(graph.omitted.nodes).toBe(folded);
  });
});

describe('M1-20 AC-2 an aggregated graph says what it folded and what it kept', () => {
  const fan = (
    names: string[],
    extra: TopologyBinding[] = [],
  ): RoutingTopology => ({
    exchanges: [x('fan', { type: 'fanout' })],
    queues: names.map((name) => q(name)),
    bindings: [...names.map((name) => bind('fan', name)), ...extra],
  });

  it('uses the whole cap: the largest prefix that fits, not one less', async () => {
    // k shown queues cost 2k + 1 elements here (the exchange, k queues, k edges, an aggregate and
    // its edge), so a cap of 11 is met exactly by five nodes.
    const graph = await graphOf(fan(['q1', 'q2', 'q3', 'q4', 'q5', 'q6']), {
      maxElements: 11,
    });

    expect(graph.elements).toBe(11);
    expect(graph.nodes.filter((n) => n.kind === 'queue')).toHaveLength(4);
    expect(graph.nodes.find((n) => n.id === 'x:fan')).toMatchObject({
      hasMore: true,
    });
  });

  it('keeps the best connected nodes first, whatever their names', async () => {
    const names = ['qa', 'qb', 'qc', 'qd', 'qe', 'qf'];
    // qf is the only queue that is also bound to another exchange: it ranks first among the queues.
    const graph = await graphOf(
      {
        ...fan(names, [bind('other', 'qf')]),
        exchanges: [x('fan', { type: 'fanout' }), x('other')],
      },
      { maxElements: 12 },
    );

    expect(graph.nodes.some((n) => n.id === 'q:qf')).toBe(true);
    expect(graph.nodes.some((n) => n.id === 'q:qa')).toBe(true);
  });

  it('merges parallel edges into one that counts them, and keeps the key of a single one', async () => {
    const parallel = Array.from({ length: 30 }, (_, i) =>
      bind('e', 'a', `k${String(i)}`),
    );
    const graph = await graphOf(
      {
        exchanges: [x('e')],
        queues: [q('a'), q('b')],
        bindings: [...parallel, bind('e', 'b', 'only')],
      },
      { maxElements: 12 },
    );

    expect(graph.aggregated).toBe(true);
    const toA = graph.edges.find((e) => e.to === 'q:a');
    const toB = graph.edges.find((e) => e.to === 'q:b');
    expect(toA).toMatchObject({ kind: 'binding', count: 30, label: null });
    expect(toB).toMatchObject({ kind: 'binding', count: 1, label: 'only' });
    expect(graph.omitted.edges).toBe(0);
    expect(graph.scope.edges).toBe(31);
  });

  it('lists the names it folded in order, five at most', async () => {
    const names = ['q9', 'q8', 'q7', 'q6', 'q5', 'q4', 'q3', 'q2', 'q1', 'q0'];
    const graph = await graphOf(fan(names), { maxElements: 10 });

    const aggregate = graph.nodes.find(
      (n) => n.kind === 'aggregate' && n.of === 'queue',
    );
    expect(aggregate?.kind === 'aggregate' && aggregate.sample).toEqual(
      [...(aggregate?.kind === 'aggregate' ? aggregate.sample : [])].sort(),
    );
    expect(aggregate?.kind === 'aggregate' && aggregate.sample).toHaveLength(5);
  });
});

describe('M1-20 AC-2 aggregates are per kind and per neighbour', () => {
  it('lists the folded names in alphabetical order, whatever the rank that folded them', async () => {
    const plain = Array.from({ length: 10 }, (_, i) => `q${String(i)}`);
    const names = [...plain, 'qw', 'qy', 'qz'];
    const topology: RoutingTopology = {
      exchanges: [x('fan', { type: 'fanout' }), x('other')],
      queues: names.map((name) => q(name)),
      bindings: [
        ...names.map((name) => bind('fan', name)),
        ...['qw', 'qy', 'qz'].map((name) => bind('other', name)),
      ],
    };
    for (let maxElements = 10; maxElements <= 40; maxElements++) {
      const graph = await graphOf(topology, { maxElements });
      const shown = new Set(
        graph.nodes.filter((n) => n.kind === 'queue').map((n) => n.name),
      );
      const folded = names.filter((name) => !shown.has(name)).sort();
      const aggregate = graph.nodes.find(
        (n) => n.kind === 'aggregate' && n.of === 'queue' && n.via === 'x:fan',
      );
      if (aggregate?.kind !== 'aggregate') continue;
      expect(aggregate.sample, String(maxElements)).toEqual(folded.slice(0, 5));
    }
  });

  it('folds the queues of two exchanges into one aggregate each', async () => {
    const side = (prefix: string) =>
      Array.from({ length: 20 }, (_, i) => q(`${prefix}${String(i)}`));
    const a = side('a');
    const b = side('b');
    const graph = await graphOf(
      {
        exchanges: [x('f1', { type: 'fanout' }), x('f2', { type: 'fanout' })],
        queues: [...a, ...b],
        bindings: [
          ...a.map((queue) => bind('f1', queue.name)),
          ...b.map((queue) => bind('f2', queue.name)),
        ],
      },
      { maxElements: 12 },
    );

    const vias = graph.nodes.flatMap((n) =>
      n.kind === 'aggregate' ? [n.via] : [],
    );
    expect(vias.sort()).toEqual(['x:f1', 'x:f2']);
    expect(graph.nodes.filter((n) => n.kind === 'exchange')).toHaveLength(2);
  });
});

describe('M1-20 AC-3 subgraph depth is at most 2 and the focus must exist', () => {
  const chain: RoutingTopology = {
    exchanges: ['a', 'b', 'c', 'd'].map((n) => x(n)),
    queues: [q('qd')],
    bindings: [
      bind('a', 'b', '', 'exchange'),
      bind('b', 'c', '', 'exchange'),
      bind('c', 'd', '', 'exchange'),
      bind('d', 'qd'),
    ],
  };
  const around = (depth: 0 | 1 | 2, name = 'b') =>
    graphOf(chain, { focus: { kind: 'exchange', name }, depth });

  it('depth 0 is the focus alone, 1 adds its neighbours, 2 their neighbours', async () => {
    expect(ids((await around(0)).nodes)).toEqual(['x:b']);
    expect(ids((await around(1)).nodes)).toEqual(['x:a', 'x:b', 'x:c']);
    expect(ids((await around(2)).nodes)).toEqual(['x:a', 'x:b', 'x:c', 'x:d']);
  });

  it('marks the nodes that have neighbours the answer does not show', async () => {
    const graph = await around(1);

    const more = Object.fromEntries(
      graph.nodes.map((n) => [n.id, n.kind !== 'aggregate' && n.hasMore]),
    );
    expect(more).toEqual({ 'x:a': false, 'x:b': false, 'x:c': true });
    expect(graph).toMatchObject({
      focus: { kind: 'exchange', name: 'b' },
      depth: 1,
      scope: { nodes: 3, edges: 2 },
      // The vhost is bigger than the scope; the totals stay the vhost's.
      totals: { exchanges: 4, queues: 1, bindings: 4 },
    });
  });

  it('follows an edge against its direction and finds a queue by name', async () => {
    const graph = await graphOf(chain, {
      focus: { kind: 'queue', name: 'qd' },
      depth: 2,
    });

    expect(ids(graph.nodes)).toEqual(['x:c', 'x:d', 'q:qd']);
  });

  it('says an unknown focus is not found, and an exchange is not a queue of the same name', async () => {
    const missing = await buildGraph(
      chain,
      request({ focus: { kind: 'exchange', name: 'nope' } }),
    );
    const wrongKind = await buildGraph(
      chain,
      request({ focus: { kind: 'queue', name: 'a' } }),
    );

    expect(missing).toEqual({ kind: 'focus-not-found' });
    expect(wrongKind).toEqual({ kind: 'focus-not-found' });
  });
});

describe('M1-20 AC-1 subgraph of a large scope is capped and keeps its focus', () => {
  it('keeps the focus and the best connected neighbours, and folds the rest', async () => {
    const queues = Array.from({ length: 400 }, (_, i) => q(`q${String(i)}`));
    const topology: RoutingTopology = {
      exchanges: [x('hub', { type: 'fanout' }), x('side')],
      queues,
      bindings: [
        ...queues.map((queue) => bind('hub', queue.name)),
        // q0 is also bound to `side`: the best connected queue is shown first.
        bind('side', 'q0'),
      ],
    };

    const graph = await graphOf(topology, {
      focus: { kind: 'exchange', name: 'hub' },
      depth: 2,
      maxElements: 40,
    });

    expect(graph.elements).toBeLessThanOrEqual(40);
    expect(graph.nodes.some((n) => n.id === 'x:hub')).toBe(true);
    expect(graph.nodes.some((n) => n.id === 'q:q0')).toBe(true);
    // The exchange "side" is two hops away and only reachable through q0: it is folded, hanging from q0.
    expect(graph.nodes.some((n) => n.id === 'x:side')).toBe(false);
    expect(
      graph.nodes.find((n) => n.kind === 'aggregate' && n.of === 'exchange'),
    ).toMatchObject({ via: 'q:q0', count: 1, sample: ['side'] });
    expect(graph.aggregated).toBe(true);
    expect(graph.scope.nodes).toBe(402);
    expect(graph.omitted.edges).toBe(
      graph.scope.edges -
        graph.edges.filter((e) => e.kind !== 'aggregate').length,
    );
  });
});

describe('M1-20 AC-1 the cap holds for any topology', () => {
  it('never exceeds the cap, loses no node and draws no edge to a node that is not there', async () => {
    for (let seed = 1; seed <= 150; seed++) {
      const topology = randomTopology(seed);
      for (const maxElements of [10, 25, 60, 2_000]) {
        for (const focus of [
          undefined,
          { kind: 'exchange' as const, name: 'x0' },
        ]) {
          const result = await buildGraph(
            topology,
            request({
              maxElements,
              depth: 2,
              ...(focus === undefined ? {} : { focus }),
            }),
          );
          const label = `seed ${String(seed)} cap ${String(maxElements)} ${focus?.name ?? 'whole'}`;
          if (result.kind !== 'ok') throw new Error(`${label}: no focus`);
          const g = result.graph;
          expect(g.elements, label).toBe(g.nodes.length + g.edges.length);
          expect(g.elements, label).toBeLessThanOrEqual(maxElements);
          const nodeIds = new Set(ids(g.nodes));
          expect(nodeIds.size, label).toBe(g.nodes.length);
          for (const edge of g.edges) {
            expect(nodeIds.has(edge.from) && nodeIds.has(edge.to), label).toBe(
              true,
            );
          }
          expect(new Set(g.edges.map((e) => e.id)).size, label).toBe(
            g.edges.length,
          );
          const individually = g.nodes.filter(
            (n) => n.kind !== 'aggregate',
          ).length;
          const folded = g.nodes.reduce(
            (s, n) => s + (n.kind === 'aggregate' ? n.count : 0),
            0,
          );
          expect(individually + folded, label).toBe(g.scope.nodes);
          expect(g.omitted.nodes, label).toBe(folded);
          expect(g.aggregated, label).toBe(
            folded > 0 ||
              g.edges.some((e) => e.kind !== 'aggregate' && e.count > 1),
          );
          if (focus !== undefined)
            expect(nodeIds.has('x:x0'), label).toBe(true);
        }
      }
    }
  });
});

describe('M1-20 AC-13 the graph is built in turns of the event loop', () => {
  it('yields while it works on a large vhost, and the yields change nothing', async () => {
    const topology = randomTopology(7);
    let yields = 0;

    const often = await graphOf(topology, {
      every: 5,
      maxElements: 30,
      yieldNow: () => {
        yields += 1;
        return Promise.resolve();
      },
    });
    const never = await graphOf(topology, {
      every: 1_000_000,
      maxElements: 30,
      yieldNow: () => Promise.reject(new Error('should not yield')),
    });

    expect(yields).toBeGreaterThan(10);
    expect(often).toEqual(never);
  });
});
