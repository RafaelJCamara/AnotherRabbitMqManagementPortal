import { describe, expect, it } from 'vitest';

import { findLoops } from './e2e.ts';
import { simulate } from './simulate.ts';
import { bind, bindX, exchange, topology } from './testing.ts';

const id = (prefix: string, n: number): string => prefix + String(n);

const chain = (length: number, queue = 'q') =>
  topology(
    Array.from({ length }, (_, i) => exchange(id('x', i), 'fanout')),
    [queue],
    [
      ...Array.from({ length: length - 1 }, (_, i) =>
        bindX(id('x', i), id('x', i + 1)),
      ),
      bind(id('x', length - 1), queue),
    ],
  );

const publishX0 = { exchange: 'x0', routingKey: '' };

describe('simulate: bounded work (I-6, I-13)', () => {
  it('M1-02 AC-10 depth: an exchange beyond maxDepth is not expanded, counted, and the answer is a lower bound', () => {
    const t = chain(4); // x0 -> x1 -> x2 -> x3 -> q
    const cut = simulate(t, publishX0, { maxDepth: 1 });
    expect(cut.truncation.depth).toBe(1); // x2; x3 is never reached
    expect(cut).toMatchObject({
      queues: [],
      exact: false,
      outcome: 'indeterminate',
      fate: 'unknown',
      unroutable: false,
      reachedExchanges: ['x0', 'x1'],
    });
    expect(cut.notes).toContainEqual({ code: 'truncated', detail: 'depth' });
    expect(simulate(t, publishX0, { maxDepth: 3 })).toMatchObject({
      queues: ['q'],
      exact: true,
      truncation: { depth: 0 },
    });
    expect(simulate(t, publishX0, { maxDepth: 0 }).truncation.depth).toBe(1);
  });

  it('M1-02 AC-10 depth: with the default limit a chain of 70 is cut and a chain of 60 is not', () => {
    expect(simulate(chain(70), publishX0)).toMatchObject({
      exact: false,
      outcome: 'indeterminate',
    });
    expect(simulate(chain(70), publishX0).truncation.depth).toBe(1);
    expect(simulate(chain(60), publishX0)).toMatchObject({
      exact: true,
      queues: ['q'],
    });
  });

  it('M1-02 AC-10 exchanges: more expanded exchanges than maxExchanges are counted', () => {
    const cut = simulate(chain(5), publishX0, { maxExchanges: 2 });
    expect(cut.reachedExchanges).toEqual(['x0', 'x1']);
    expect(cut.truncation.exchanges).toBe(1);
    expect(cut.exact).toBe(false);
  });

  it('M1-02 AC-10 bindings: the evaluation budget stops the scan and counts the bindings not evaluated', () => {
    const t = topology(
      [exchange('f', 'fanout')],
      Array.from({ length: 10 }, (_, i) => id('q', i)),
      Array.from({ length: 10 }, (_, i) => bind('f', id('q', i))),
    );
    const cut = simulate(
      t,
      { exchange: 'f', routingKey: '' },
      { maxBindingsScanned: 3 },
    );
    expect(cut.queues).toEqual(['q0', 'q1', 'q2']);
    expect(cut).toMatchObject({ outcome: 'routed', exact: false });
    expect(cut.truncation.bindings).toBe(7);
    expect(cut.notes).toContainEqual({ code: 'truncated', detail: 'bindings' });
  });

  it('M1-02 AC-10 bindings: a cut scan with no match does not follow the alternate exchange', () => {
    const t = topology(
      [
        exchange('x', 'direct', { alternateExchange: 'ae' }),
        exchange('ae', 'fanout'),
      ],
      ['q', 'q-ae'],
      [bind('x', 'q', 'a'), bind('x', 'q', 'b'), bind('ae', 'q-ae')],
    );
    expect(simulate(t, { exchange: 'x', routingKey: 'z' }).queues).toEqual([
      'q-ae',
    ]);
    const cut = simulate(
      t,
      { exchange: 'x', routingKey: 'z' },
      { maxBindingsScanned: 1 },
    );
    expect(cut).toMatchObject({
      usedAE: false,
      queues: [],
      exact: false,
      outcome: 'indeterminate',
    });
  });

  it('M1-02 AC-10 queues and paths: a result list is capped and counted, a path cap keeps the queue', () => {
    const fan = topology(
      [exchange('f', 'fanout')],
      Array.from({ length: 5 }, (_, i) => id('q', i)),
      Array.from({ length: 5 }, (_, i) => bind('f', id('q', i))),
    );
    const queues = simulate(
      fan,
      { exchange: 'f', routingKey: '' },
      { maxQueues: 2 },
    );
    expect(queues.queues).toHaveLength(2);
    expect(queues.truncation.queues).toBe(3);
    expect(queues.exact).toBe(false);

    const twice = topology(
      [exchange('f', 'fanout')],
      ['q'],
      [bind('f', 'q', '', { a: 1 }), bind('f', 'q', '', { a: 2 })],
    );
    const paths = simulate(
      twice,
      { exchange: 'f', routingKey: '' },
      { maxPathsPerQueue: 1 },
    );
    expect(paths.paths).toHaveLength(1);
    expect(paths.truncation.paths).toBe(1);
    // every queue is still listed: the queue set is complete
    expect(paths).toMatchObject({ queues: ['q'], exact: true });
    expect(paths.notes).toContainEqual({ code: 'truncated', detail: 'paths' });
  });

  it('M1-02 AC-10 loops and notes are capped and counted', () => {
    const t = topology(
      [
        exchange('a', 'fanout'),
        exchange('b', 'fanout'),
        exchange('c', 'fanout'),
      ],
      [],
      [
        bindX('a', 'a'),
        bindX('a', 'b'),
        bindX('b', 'b'),
        bindX('a', 'c'),
        bindX('c', 'c'),
      ],
    );
    const loops = simulate(
      t,
      { exchange: 'a', routingKey: '' },
      { maxLoops: 1 },
    );
    expect(loops.loops).toHaveLength(1);
    expect(loops.truncation.loops).toBe(2);

    const dangling = topology(
      [exchange('f', 'fanout')],
      [],
      ['a', 'b', 'c', 'd'].map((name) => bind('f', name)),
    );
    const noted = simulate(
      dangling,
      { exchange: 'f', routingKey: '' },
      { maxNotes: 1 },
    );
    expect(noted.notes).toHaveLength(1);
    expect(noted.truncation.notes).toBeGreaterThan(0);
  });

  it('M1-02 AC-10 topic words: a pattern or key over maxTopicWords never matches and is counted', () => {
    const t = topology(
      [exchange('t', 'topic')],
      ['q'],
      [bind('t', 'q', 'a.b.c.d.e')],
    );
    const publish = { exchange: 't', routingKey: 'a.b.c.d.e' };
    expect(simulate(t, publish).queues).toEqual(['q']);
    const cut = simulate(t, publish, { maxTopicWords: 3 });
    expect(cut).toMatchObject({
      queues: [],
      exact: false,
      outcome: 'indeterminate',
    });
    expect(cut.truncation.topicWords).toBe(1);
  });

  it('M1-02 AC-10 default limits cut nothing for a fanout of 5,000 bindings', () => {
    const queues = Array.from({ length: 5000 }, (_, i) => id('q', i));
    const t = topology(
      [exchange('f', 'fanout')],
      queues,
      queues.map((name) => bind('f', name)),
    );
    const result = simulate(t, { exchange: 'f', routingKey: '' });
    expect(result.queues).toHaveLength(5000);
    expect(result.exact).toBe(true);
    expect(Object.values(result.truncation).every((count) => count === 0)).toBe(
      true,
    );
  });

  it('M1-02 AC-10 a limit that is not a non-negative finite number is ignored, a fraction is floored', () => {
    const t = chain(4);
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(simulate(t, publishX0, { maxDepth: bad }).queues).toEqual(['q']);
    }
    expect(simulate(t, publishX0, { maxDepth: 1.9 }).truncation.depth).toBe(1);
  });

  it('M1-02 AC-8 the loop pass is iterative: a chain of 50,000 edges and a long cycle do not overflow the stack', () => {
    const edges = Array.from({ length: 50_000 }, (_, i) => ({
      from: id('n', i),
      to: id('n', i + 1),
    }));
    expect(findLoops(edges)).toEqual([]);
    const cycle = [...edges, { from: 'n50000', to: 'n0' }];
    const [loop] = findLoops(cycle);
    expect(loop).toHaveLength(50_001);
  });
});
