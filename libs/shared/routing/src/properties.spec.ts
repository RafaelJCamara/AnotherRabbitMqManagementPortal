import fc from 'fast-check';
import { describe, it } from 'vitest';

import { headersRule } from './headers.ts';
import { simulate } from './simulate.ts';
import { topicMatches } from './topic.ts';
import type {
  HeaderTable,
  RoutingResult,
  RoutingTopology,
  TopologyBinding,
} from './types.ts';

// ---------------------------------------------------------------------------------------------
// Generators: small random vhosts. Names are drawn from small sets so that bindings collide.
// ---------------------------------------------------------------------------------------------

const TYPES = ['direct', 'fanout', 'topic', 'headers'] as const;
const KEYS = [
  '',
  'a',
  'b',
  'a.b',
  'a.*',
  'a.#',
  '#',
  '*',
  '*.b',
  'a.b.c',
  'b.',
];
const ARG_NAMES = ['p', 'q', 'x-r'];
const ARG_VALUES = [1, 2, 'one', null] as const;

const argsArb: fc.Arbitrary<HeaderTable> = fc
  .tuple(
    fc.constantFrom(
      'all',
      'any',
      'all-with-x',
      'any-with-x',
      'bogus',
      undefined,
    ),
    fc.array(
      fc.tuple(fc.constantFrom(...ARG_NAMES), fc.constantFrom(...ARG_VALUES)),
      {
        maxLength: 3,
      },
    ),
  )
  .map(([mode, pairs]) => ({
    ...Object.fromEntries(pairs),
    ...(mode === undefined ? {} : { 'x-match': mode }),
  }));

const headersArb: fc.Arbitrary<HeaderTable> = fc
  .array(
    fc.tuple(fc.constantFrom(...ARG_NAMES), fc.constantFrom(...ARG_VALUES)),
    {
      maxLength: 3,
    },
  )
  .map((pairs) => Object.fromEntries(pairs));

interface Shape {
  readonly exchanges: number;
  readonly queues: number;
  readonly types: readonly (typeof TYPES)[number][];
  readonly aeAllowed: boolean;
}

function topologyArb(
  shape: Partial<Shape> = {},
): fc.Arbitrary<RoutingTopology> {
  const exchanges = shape.exchanges ?? 6;
  const queues = shape.queues ?? 4;
  const types = shape.types ?? TYPES;
  const exchangeName = fc.nat(exchanges - 1).map((i) => `x${String(i)}`);
  const queueName = fc.nat(queues - 1).map((i) => `q${String(i)}`);
  const binding: fc.Arbitrary<TopologyBinding> = fc
    .record({
      source: exchangeName,
      toExchange: fc.boolean(),
      exchange: exchangeName,
      queue: queueName,
      key: fc.constantFrom(...KEYS),
      args: argsArb,
    })
    .map(({ source, toExchange, exchange, queue, key, args }) => ({
      source,
      destination: toExchange ? exchange : queue,
      destinationType: toExchange ? 'exchange' : 'queue',
      routingKey: key,
      arguments: args,
    }));
  return fc
    .record({
      kinds: fc.array(fc.constantFrom(...types), {
        minLength: exchanges,
        maxLength: exchanges,
      }),
      aes: fc.array(fc.option(exchangeName, { nil: undefined }), {
        minLength: exchanges,
        maxLength: exchanges,
      }),
      bindings: fc.array(binding, { maxLength: 14 }),
    })
    .map(({ kinds, aes, bindings }) => ({
      exchanges: kinds.map((type, i) => ({
        name: `x${String(i)}`,
        type,
        ...(shape.aeAllowed === false || aes[i] === undefined
          ? {}
          : { alternateExchange: aes[i] }),
      })),
      queues: Array.from({ length: queues }, (_, i) => ({
        name: `q${String(i)}`,
      })),
      bindings,
    }));
}

const publishArb = (exchanges: number) =>
  fc.record({
    exchange: fc.nat(exchanges - 1).map((i) => `x${String(i)}`),
    routingKey: fc.constantFrom('', 'a', 'b', 'a.b', 'a.b.c', 'b.', 'zz'),
    headers: headersArb,
  });

// ---------------------------------------------------------------------------------------------
// An independent walk: depth first, with the visited set marked on entry.
// ---------------------------------------------------------------------------------------------

function oracle(
  topo: RoutingTopology,
  publish: { exchange: string; routingKey: string; headers: HeaderTable },
): Set<string> {
  const found = new Set<string>();
  const visited = new Set<string>();
  const queueNames = new Set(topo.queues.map((q) => q.name));
  const exchanges = new Map(topo.exchanges.map((x) => [x.name, x]));
  const visit = (name: string): void => {
    visited.add(name);
    const x = exchanges.get(name);
    if (x === undefined) return;
    const own = topo.bindings.filter((b) => {
      if (b.source !== name) return false;
      switch (x.type) {
        case 'direct':
          return b.routingKey === publish.routingKey;
        case 'fanout':
          return true;
        case 'topic':
          return topicMatches(b.routingKey, publish.routingKey);
        default:
          return headersRule(b, publish.headers) !== null;
      }
    });
    const next = own.map((b) => ({
      to: b.destination,
      isQueue: b.destinationType === 'queue',
    }));
    if (own.length === 0 && x.alternateExchange) {
      next.push({ to: x.alternateExchange, isQueue: false });
    }
    for (const { to, isQueue } of next) {
      if (isQueue) {
        if (queueNames.has(to)) found.add(to);
      } else if (!visited.has(to) && exchanges.has(to)) visit(to);
    }
  };
  visit(publish.exchange);
  return found;
}

const sortedUnique = (values: readonly string[]): boolean =>
  values.join() === [...new Set(values)].sort().join();

function wellFormed(result: RoutingResult, exchange: string): boolean {
  const reached = result.reachedExchanges;
  return (
    sortedUnique(result.queues) &&
    new Set(reached).size === reached.length &&
    result.paths.every(
      (path) =>
        result.queues.includes(path.queue) &&
        path.hops.length > 0 &&
        path.hops[0]?.exchange === exchange &&
        path.hops.at(-1)?.destination === path.queue &&
        path.hops.at(-1)?.destinationType === 'queue' &&
        path.hops.every(
          (hop, i) => i === 0 || hop.exchange === path.hops[i - 1]?.destination,
        ),
    ) &&
    result.queues.every((queue) =>
      result.paths.some((path) => path.queue === queue),
    )
  );
}

describe('routing properties', () => {
  it('M1-02 AC-8 the simulation terminates on cyclic graphs and equals an independent walk (property)', () => {
    fc.assert(
      fc.property(topologyArb(), publishArb(6), (topo, publish) => {
        const result = simulate(topo, publish);
        return (
          result.exact &&
          result.queues.join() === [...oracle(topo, publish)].sort().join() &&
          wellFormed(result, publish.exchange)
        );
      }),
      { numRuns: 400 },
    );
  });
  it('M1-02 AC-8 a dense graph of fanout exchanges with many cycles terminates and expands each exchange once (property)', () => {
    const dense = fc
      .array(
        fc.record({
          from: fc.nat(11).map((i) => `x${String(i)}`),
          to: fc.nat(11).map((i) => `x${String(i)}`),
        }),
        { maxLength: 60 },
      )
      .map(
        (edges): RoutingTopology => ({
          exchanges: Array.from({ length: 12 }, (_, i) => ({
            name: `x${String(i)}`,
            type: 'fanout',
          })),
          queues: [{ name: 'q' }],
          bindings: [
            ...edges.map(({ from, to }) => ({
              source: from,
              destination: to,
              destinationType: 'exchange' as const,
              routingKey: '',
            })),
            {
              source: 'x11',
              destination: 'q',
              destinationType: 'queue' as const,
              routingKey: '',
            },
          ],
        }),
      );
    fc.assert(
      fc.property(dense, (topo) => {
        const result = simulate(topo, { exchange: 'x0', routingKey: '' });
        return (
          result.reachedExchanges.length <= 12 &&
          new Set(result.reachedExchanges).size ===
            result.reachedExchanges.length &&
          result.exact
        );
      }),
      { numRuns: 100 },
    );
  });

  it('M1-02 AC-3 fanout reaches every bound queue and direct equals an exact-match filter (property)', () => {
    const flat = fc
      .record({
        keys: fc.array(fc.constantFrom('', 'a', 'b'), { maxLength: 8 }),
        key: fc.constantFrom('', 'a', 'b', 'c'),
      })
      .map(({ keys, key }) => {
        const bindings = keys.map((routingKey, i) => ({
          source: 'x',
          destination: `q${String(i % 4)}`,
          destinationType: 'queue' as const,
          routingKey,
        }));
        return { bindings, key };
      });
    fc.assert(
      fc.property(flat, ({ bindings, key }) => {
        const queues = ['q0', 'q1', 'q2', 'q3'].map((name) => ({ name }));
        const run = (type: string) =>
          simulate(
            { exchanges: [{ name: 'x', type }], queues, bindings },
            { exchange: 'x', routingKey: key },
          ).queues;
        const bound = [...new Set(bindings.map((b) => b.destination))].sort();
        const exact = [
          ...new Set(
            bindings
              .filter((b) => b.routingKey === key)
              .map((b) => b.destination),
          ),
        ].sort();
        return (
          run('fanout').join() === bound.join() &&
          run('direct').join() === exact.join()
        );
      }),
      { numRuns: 200 },
    );
  });

  it('M1-02 AC-2 a topic binding # receives every routing key (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('a', 'b', '', 'zz', '*', '#'), {
          maxLength: 9,
        }),
        (words) => {
          const result = simulate(
            {
              exchanges: [{ name: 't', type: 'topic' }],
              queues: [{ name: 'q' }],
              bindings: [
                {
                  source: 't',
                  destination: 'q',
                  destinationType: 'queue',
                  routingKey: '#',
                },
              ],
            },
            { exchange: 't', routingKey: words.join('.') },
          );
          return result.queues.join() === 'q';
        },
      ),
      { numRuns: 200 },
    );
  });

  it('M1-02 AC-5 on one exchange the queues of [key, ...CC, ...BCC] are the union of the queues of each key alone (property)', () => {
    const keysArb = fc.constantFrom('', 'a', 'b', 'a.b', 'zz');
    fc.assert(
      fc.property(
        topologyArb({ types: ['direct', 'topic', 'fanout'], aeAllowed: false }),
        publishArb(6),
        fc.array(keysArb, { maxLength: 3 }),
        fc.array(keysArb, { maxLength: 3 }),
        (full, publish, cc, bcc) => {
          // queue destinations only: the keys apply at every exchange of a chain, so the union
          // law is a law of one exchange
          const topo = {
            ...full,
            bindings: full.bindings.filter(
              (b) => b.destinationType === 'queue',
            ),
          };
          const withKeys = simulate(topo, {
            ...publish,
            headers: { CC: cc, BCC: bcc },
          }).queues;
          const union = new Set<string>();
          for (const key of [publish.routingKey, ...cc, ...bcc]) {
            for (const queue of simulate(topo, {
              exchange: publish.exchange,
              routingKey: key,
            }).queues) {
              union.add(queue);
            }
          }
          return withKeys.join() === [...union].sort().join();
        },
      ),
      { numRuns: 200 },
    );
  });

  it('M1-02 AC-5 without alternate exchanges, extra CC and BCC keys never remove a queue, chains included (property)', () => {
    const keysArb = fc.constantFrom('', 'a', 'b', 'a.b', 'zz');
    fc.assert(
      fc.property(
        topologyArb({ types: ['direct', 'topic', 'fanout'], aeAllowed: false }),
        publishArb(6),
        fc.array(keysArb, { maxLength: 3 }),
        (topo, publish, cc) => {
          const alone = simulate(topo, publish).queues;
          const more = simulate(topo, {
            ...publish,
            headers: { CC: cc },
          }).queues;
          return alone.every((queue) => more.includes(queue));
        },
      ),
      { numRuns: 200 },
    );
  });
  it('M1-02 AC-7 an exchange with no destination of its own routes exactly as its alternate exchange does (property)', () => {
    fc.assert(
      fc.property(topologyArb(), publishArb(6), (topo, publish) => {
        const x = topo.exchanges.find((e) => e.name === publish.exchange);
        const ae = x?.alternateExchange;
        const own = simulate(
          {
            ...topo,
            bindings: topo.bindings.filter(
              (b) => b.source !== publish.exchange,
            ),
          },
          publish,
        );
        if (ae === undefined || ae === null) return own.queues.length === 0;
        const viaAe = simulate(
          {
            ...topo,
            bindings: topo.bindings.filter(
              (b) => b.source !== publish.exchange,
            ),
          },
          { ...publish, exchange: ae },
        );
        return own.usedAE && own.queues.join() === viaAe.queues.join();
      }),
      { numRuns: 200 },
    );
  });

  it('M1-02 AC-12 the queue set does not depend on the order of the bindings (property)', () => {
    fc.assert(
      fc.property(topologyArb(), publishArb(6), (topo, publish) => {
        const forward = simulate(topo, publish);
        const backward = simulate(
          { ...topo, bindings: [...topo.bindings].reverse() },
          publish,
        );
        return (
          forward.queues.join() === backward.queues.join() &&
          forward.usedAE === backward.usedAE &&
          [...forward.reachedExchanges].sort().join() ===
            [...backward.reachedExchanges].sort().join()
        );
      }),
      { numRuns: 200 },
    );
  });

  it('M1-02 AC-10 tiny limits never throw and never claim an exact answer that is not (property)', () => {
    fc.assert(
      fc.property(
        topologyArb(),
        publishArb(6),
        fc.record({
          maxDepth: fc.nat(3),
          maxExchanges: fc.nat(4),
          maxBindingsScanned: fc.nat(10),
          maxQueues: fc.nat(3),
          maxPathsPerQueue: fc.nat(2),
          maxLoops: fc.nat(2),
          maxNotes: fc.nat(3),
        }),
        (topo, publish, limits) => {
          const full = simulate(topo, publish);
          const cut = simulate(topo, publish, limits);
          // a cut run finds a subset; an exact cut run equals the full run
          return (
            cut.queues.every((queue) => full.queues.includes(queue)) &&
            (!cut.exact || cut.queues.join() === full.queues.join())
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});
