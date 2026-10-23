import { describe, expect, it } from 'vitest';

import { indexTopology } from './e2e.ts';
import { simulate } from './simulate.ts';
import { bind, bindX, deepFreeze, exchange, topology } from './testing.ts';

describe('simulate: direct and fanout', () => {
  const t = topology(
    [exchange('d'), exchange('f', 'fanout')],
    ['q1', 'q2', 'q3'],
    [
      bind('d', 'q1', 'a'),
      bind('d', 'q2', 'b'),
      bind('d', 'q3', 'a'),
      bind('d', 'q1', 'a', { note: 'second binding, other arguments' }),
      bind('f', 'q1', 'ignored'),
      bind('f', 'q2'),
      bind('f', 'q3', 'a', { 'x-match': 'any' }),
    ],
  );

  it('M1-02 AC-3 direct delivers to the bindings whose key equals the routing key', () => {
    const result = simulate(t, { exchange: 'd', routingKey: 'a' });
    expect(result.queues).toEqual(['q1', 'q3']);
    expect(result.outcome).toBe('routed');
    expect(result.fate).toBe('delivered');
    expect(result.exact).toBe(true);
    // q1 is bound twice: two paths, each with the binding that matched
    const q1 = result.paths.filter((path) => path.queue === 'q1');
    expect(q1).toHaveLength(2);
    expect(q1[0]?.hops).toEqual([
      {
        exchange: 'd',
        how: 'binding',
        destination: 'q1',
        destinationType: 'queue',
        binding: {
          source: 'd',
          destination: 'q1',
          destinationType: 'queue',
          routingKey: 'a',
        },
        rule: { kind: 'direct', routingKey: 'a', keySource: 'routing-key' },
      },
    ]);
    expect(simulate(t, { exchange: 'd', routingKey: 'zzz' }).queues).toEqual(
      [],
    );
  });

  it('M1-02 AC-3 fanout delivers to every bound queue, whatever the key, headers and arguments', () => {
    for (const routingKey of ['', 'a', 'nothing']) {
      const result = simulate(t, {
        exchange: 'f',
        routingKey,
        headers: { h: 1 },
      });
      expect(result.queues).toEqual(['q1', 'q2', 'q3']);
      expect(
        result.paths.every((path) => path.hops[0]?.rule?.kind === 'fanout'),
      ).toBe(true);
    }
  });

  it('M1-02 AC-3 a topology index can be reused and gives the same answer', () => {
    const index = indexTopology(t);
    const publish = { exchange: 'd', routingKey: 'a' };
    expect(simulate(index, publish)).toEqual(simulate(t, publish));
  });
});

describe('simulate: topic and headers exchanges', () => {
  const t = topology(
    [exchange('t', 'topic'), exchange('h', 'headers')],
    ['q1', 'q2', 'q3', 'q4'],
    [
      bind('t', 'q1', 'orders.*'),
      bind('t', 'q2', 'orders.#'),
      bind('t', 'q3', '#'),
      bind('t', 'q4', ''),
      bind('h', 'q1', '', { 'x-match': 'all', region: 'eu', tier: 1 }),
      bind('h', 'q2', '', { 'x-match': 'any', region: 'eu', tier: 1 }),
      bind('h', 'q3', '', { 'x-match': 'all-with-x', 'x-trace': 'on' }),
      bind('h', 'q4', '', { 'x-match': 'bogus', region: 'eu' }),
    ],
  );

  it('M1-02 AC-2 topic delivers by word patterns, the empty key included', () => {
    expect(
      simulate(t, { exchange: 't', routingKey: 'orders.new' }).queues,
    ).toEqual(['q1', 'q2', 'q3']);
    expect(simulate(t, { exchange: 't', routingKey: 'orders' }).queues).toEqual(
      ['q2', 'q3'],
    );
    expect(simulate(t, { exchange: 't', routingKey: '' }).queues).toEqual([
      'q3',
      'q4',
    ]);
    const rule = simulate(t, { exchange: 't', routingKey: 'orders.new' })
      .paths[0]?.hops[0]?.rule;
    expect(rule).toEqual({
      kind: 'topic',
      pattern: 'orders.*',
      routingKey: 'orders.new',
      keySource: 'routing-key',
    });
  });

  it('M1-02 AC-1 headers delivers by x-match, with an invalid x-match noted and treated as all', () => {
    const result = simulate(t, {
      exchange: 'h',
      routingKey: 'ignored',
      headers: { region: 'eu', 'x-trace': 'on' },
    });
    // q1 needs region and tier; q2 (any) has region; q3 (all-with-x) has x-trace; q4 (bogus) is all: region
    expect(result.queues).toEqual(['q2', 'q3', 'q4']);
    expect(result.notes).toContainEqual({
      code: 'invalid-x-match',
      exchange: 'h',
      detail: 'q4',
    });
    expect(
      simulate(t, {
        exchange: 'h',
        routingKey: '',
        headers: { region: 'eu', tier: 1 },
      }).queues,
    ).toEqual(['q1', 'q2', 'q4']);
  });
});

describe('simulate: the default exchange', () => {
  const t = topology(
    [
      exchange('', 'direct', { alternateExchange: 'ae' }),
      exchange('ae', 'fanout'),
    ],
    ['q1', 'q2', 'dead'],
    [bind('', 'q2', 'q1'), bind('ae', 'dead')],
  );

  it('M1-02 AC-4 routes by queue name, with no binding and no alternate exchange', () => {
    const result = simulate(t, { exchange: '', routingKey: 'q1' });
    expect(result.queues).toEqual(['q1']);
    expect(result.usedAE).toBe(false);
    expect(result.paths[0]?.hops).toEqual([
      {
        exchange: '',
        how: 'default-exchange',
        destination: 'q1',
        destinationType: 'queue',
        binding: null,
        rule: {
          kind: 'default-exchange',
          routingKey: 'q1',
          keySource: 'routing-key',
        },
      },
    ]);
    // a binding whose source is the default exchange cannot exist; it is ignored and noted
    expect(result.notes).toContainEqual({
      code: 'ignored-default-exchange-binding',
      exchange: '',
      detail: '1',
    });
  });

  it('M1-02 AC-4 a key that names no queue is unroutable: returned when mandatory, dropped otherwise', () => {
    const dropped = simulate(t, { exchange: '', routingKey: 'nope' });
    expect(dropped).toMatchObject({
      outcome: 'unroutable',
      unroutable: true,
      fate: 'dropped',
      queues: [],
      exact: true,
      usedAE: false,
    });
    const returned = simulate(t, {
      exchange: '',
      routingKey: 'nope',
      mandatory: true,
    });
    expect(returned).toMatchObject({ unroutable: true, fate: 'returned' });
  });

  it('M1-02 AC-5 CC and BCC keys add queues on the default exchange', () => {
    const result = simulate(t, {
      exchange: '',
      routingKey: 'q1',
      headers: { CC: ['q2'], BCC: ['dead', 'nope'] },
    });
    expect(result.queues).toEqual(['dead', 'q1', 'q2']);
    expect(result.paths.map((path) => path.hops[0]?.rule)).toEqual([
      { kind: 'default-exchange', routingKey: 'dead', keySource: 'bcc' },
      { kind: 'default-exchange', routingKey: 'q1', keySource: 'routing-key' },
      { kind: 'default-exchange', routingKey: 'q2', keySource: 'cc' },
    ]);
    expect(result.keys).toEqual({
      routingKey: 'q1',
      cc: ['q2'],
      bcc: ['dead', 'nope'],
    });
    expect(result.notes).toContainEqual({ code: 'bcc-stripped' });
  });
});

describe('simulate: CC and BCC on the other exchange types', () => {
  const t = topology(
    [
      exchange('d'),
      exchange('t', 'topic'),
      exchange('f', 'fanout'),
      exchange('h', 'headers'),
    ],
    ['q1', 'q2', 'q3'],
    [
      bind('d', 'q1', 'k1'),
      bind('d', 'q2', 'k2'),
      bind('d', 'q3', 'k3'),
      bind('t', 'q1', 'a.*'),
      bind('t', 'q2', 'b.#'),
      bind('f', 'q1'),
      bind('h', 'q1', '', { a: 1 }),
    ],
  );

  it('M1-02 AC-5 direct and topic add the queues of every CC and BCC key, each path naming the key source', () => {
    const direct = simulate(t, {
      exchange: 'd',
      routingKey: 'k1',
      headers: { CC: ['k2'], BCC: ['k3'] },
    });
    expect(direct.queues).toEqual(['q1', 'q2', 'q3']);
    expect(direct.paths.map((p) => p.hops[0]?.rule)).toMatchObject([
      { keySource: 'routing-key' },
      { keySource: 'cc' },
      { keySource: 'bcc' },
    ]);
    const topic = simulate(t, {
      exchange: 't',
      routingKey: 'zzz',
      headers: { CC: ['a.x'], BCC: ['b'] },
    });
    expect(topic.queues).toEqual(['q1', 'q2']);
  });

  it('M1-02 AC-5 fanout and headers ignore the keys and say so', () => {
    const fanout = simulate(t, {
      exchange: 'f',
      routingKey: 'x',
      headers: { CC: ['k2'] },
    });
    expect(fanout.queues).toEqual(['q1']);
    expect(fanout.notes).toContainEqual({
      code: 'keys-ignored',
      exchange: 'f',
    });
    const headers = simulate(t, {
      exchange: 'h',
      routingKey: 'x',
      headers: { a: 1, BCC: ['k2'] },
    });
    expect(headers.queues).toEqual(['q1']);
    expect(headers.notes).toContainEqual({
      code: 'keys-ignored',
      exchange: 'h',
    });
  });

  it('M1-02 AC-5 the message keys apply at every exchange of a chain, not only at the first', () => {
    const chain = topology(
      [exchange('first'), exchange('second')],
      ['q'],
      [bindX('first', 'second', 'a.b.c'), bind('second', 'q', 'a')],
    );
    // alone, neither key reaches q: the first key opens the first hop, the second the last
    expect(
      simulate(chain, { exchange: 'first', routingKey: 'a.b.c' }).queues,
    ).toEqual([]);
    expect(
      simulate(chain, { exchange: 'first', routingKey: 'a' }).queues,
    ).toEqual([]);
    // together, the second exchange sees both keys
    expect(
      simulate(chain, {
        exchange: 'first',
        routingKey: 'a.b.c',
        headers: { BCC: ['a'] },
      }).queues,
    ).toEqual(['q']);
  });
  it('M1-02 AC-5 a CC or BCC header that is not an array refuses the publish with 406', () => {
    for (const [headers, header] of [
      [{ CC: 'k2' }, 'CC'],
      [{ BCC: 5 }, 'BCC'],
    ] as const) {
      const result = simulate(t, { exchange: 'd', routingKey: 'k1', headers });
      expect(result).toMatchObject({
        outcome: 'refused',
        fate: 'refused',
        queues: [],
        refusal: { code: 'invalid-routing-header', replyCode: 406, header },
      });
    }
  });
});

describe('simulate: exchange-to-exchange chains', () => {
  const t = topology(
    [
      exchange('x1', 'topic'),
      exchange('x2', 'fanout'),
      exchange('x3', 'headers'),
      exchange('a', 'fanout'),
      exchange('b', 'fanout'),
      exchange('d', 'fanout'),
      exchange('top', 'fanout'),
    ],
    ['q', 'q-diamond'],
    [
      bindX('x1', 'x2', 'orders.#'),
      bindX('x2', 'x3'),
      bind('x3', 'q', '', { 'x-match': 'any', region: 'eu' }),
      bindX('top', 'a'),
      bindX('top', 'b'),
      bindX('a', 'd'),
      bindX('b', 'd'),
      bind('d', 'q-diamond'),
      bindX('top', 'ghost'),
      bind('top', 'not-a-queue'),
    ],
  );

  it('M1-02 AC-6 a chain of different types delivers once, the path naming every hop, binding and rule', () => {
    const result = simulate(t, {
      exchange: 'x1',
      routingKey: 'orders.new',
      headers: { region: 'eu' },
    });
    expect(result.queues).toEqual(['q']);
    expect(result.paths).toHaveLength(1);
    const hops = result.paths[0]?.hops ?? [];
    expect(
      hops.map((hop) => [hop.exchange, hop.destination, hop.destinationType]),
    ).toEqual([
      ['x1', 'x2', 'exchange'],
      ['x2', 'x3', 'exchange'],
      ['x3', 'q', 'queue'],
    ]);
    expect(hops.map((hop) => hop.rule?.kind)).toEqual([
      'topic',
      'fanout',
      'headers',
    ]);
    expect(hops[0]?.binding).toEqual({
      source: 'x1',
      destination: 'x2',
      destinationType: 'exchange',
      routingKey: 'orders.#',
    });
    expect(result.reachedExchanges).toEqual(['x1', 'x2', 'x3']);
    // the chain stops where a rule does not match
    expect(
      simulate(t, {
        exchange: 'x1',
        routingKey: 'other',
        headers: { region: 'eu' },
      }).queues,
    ).toEqual([]);
    expect(
      simulate(t, {
        exchange: 'x1',
        routingKey: 'orders.new',
        headers: { region: 'us' },
      }).queues,
    ).toEqual([]);
  });

  it('M1-02 AC-6 an exchange with two parents is expanded once; missing destinations are noted, not delivered', () => {
    const result = simulate(t, { exchange: 'top', routingKey: '' });
    expect(result.queues).toEqual(['q-diamond']);
    expect(result.reachedExchanges).toEqual(['top', 'a', 'b', 'd']);
    // the first (shortest, binding order) path to d is through a
    expect(result.paths[0]?.hops.map((hop) => hop.exchange)).toEqual([
      'top',
      'a',
      'd',
    ]);
    expect(result.notes).toContainEqual({
      code: 'missing-exchange',
      exchange: 'top',
      detail: 'ghost',
    });
    expect(result.notes).toContainEqual({
      code: 'dangling-destination',
      exchange: 'top',
      detail: 'not-a-queue',
    });
    expect(result.exact).toBe(true);
    expect(result.loops).toEqual([]);
  });
});

describe('simulate: alternate exchanges', () => {
  const t = topology(
    [
      exchange('x', 'direct', { alternateExchange: 'ae1' }),
      exchange('ae1', 'direct', { alternateExchange: 'ae2' }),
      exchange('ae2', 'fanout'),
      exchange('e2e', 'direct', { alternateExchange: 'ae2' }),
      exchange('dead-end', 'direct'),
      exchange('self', 'direct', { alternateExchange: 'self' }),
      exchange('lost', 'direct', { alternateExchange: 'nowhere' }),
      exchange('via', 'fanout'),
      exchange('deep', 'direct', { alternateExchange: 'ae2' }),
    ],
    ['q-hit', 'q-ae1', 'q-ae2'],
    [
      bind('x', 'q-hit', 'hit'),
      bind('ae1', 'q-ae1', 'on-ae1'),
      bind('ae2', 'q-ae2'),
      bindX('e2e', 'dead-end', 'go'),
      bindX('via', 'deep'),
    ],
  );

  it('M1-02 AC-7 an exchange with no destination of its own uses the AE, and the AE chain is followed', () => {
    const viaAe2 = simulate(t, { exchange: 'x', routingKey: 'miss' });
    expect(viaAe2).toMatchObject({
      queues: ['q-ae2'],
      usedAE: true,
      exact: true,
    });
    expect(
      viaAe2.paths[0]?.hops.map((hop) => [
        hop.exchange,
        hop.how,
        hop.rule?.kind,
      ]),
    ).toEqual([
      ['x', 'alternate-exchange', undefined],
      ['ae1', 'alternate-exchange', undefined],
      ['ae2', 'binding', 'fanout'],
    ]);
    const viaAe1 = simulate(t, { exchange: 'x', routingKey: 'on-ae1' });
    // x has no binding for the key, so the AE is used; ae1 matches on its own
    expect(viaAe1.queues).toEqual(['q-ae1']);
  });

  it('M1-02 AC-7 an exchange that matches does not use its AE', () => {
    const result = simulate(t, { exchange: 'x', routingKey: 'hit' });
    expect(result).toMatchObject({ queues: ['q-hit'], usedAE: false });
    expect(result.reachedExchanges).toEqual(['x']);
  });

  it('M1-02 AC-7 an E2E destination that routes nowhere does not release the AE', () => {
    const result = simulate(t, { exchange: 'e2e', routingKey: 'go' });
    expect(result).toMatchObject({
      queues: [],
      usedAE: false,
      outcome: 'unroutable',
      reachedExchanges: ['e2e', 'dead-end'],
    });
  });

  it('M1-02 AC-7 the AE of an exchange reached by E2E is read the same way', () => {
    const result = simulate(t, { exchange: 'via', routingKey: 'k' });
    expect(result).toMatchObject({ queues: ['q-ae2'], usedAE: true });
    expect(result.paths[0]?.hops.map((hop) => hop.how)).toEqual([
      'binding',
      'alternate-exchange',
      'binding',
    ]);
  });

  it('M1-02 AC-7 an AE pointing at itself or at a missing exchange routes nowhere, and says so', () => {
    const self = simulate(t, { exchange: 'self', routingKey: 'k' });
    expect(self).toMatchObject({
      queues: [],
      usedAE: true,
      outcome: 'unroutable',
    });
    expect(self.loops).toEqual([{ exchanges: ['self'] }]);
    const lost = simulate(t, { exchange: 'lost', routingKey: 'k' });
    expect(lost.usedAE).toBe(true);
    expect(lost.notes).toContainEqual({
      code: 'missing-exchange',
      exchange: 'lost',
      detail: 'nowhere',
    });
  });
});

describe('simulate: loops', () => {
  it('M1-02 AC-8 a cycle of exchanges ends, expands each exchange once, delivers once and reports the loop', () => {
    const t = topology(
      [
        exchange('a', 'fanout'),
        exchange('b', 'fanout'),
        exchange('c', 'fanout'),
      ],
      ['q'],
      [
        bindX('a', 'b'),
        bindX('b', 'c'),
        bindX('c', 'a'),
        bind('c', 'q'),
        bind('b', 'q'),
      ],
    );
    const result = simulate(t, { exchange: 'a', routingKey: '' });
    expect(result.queues).toEqual(['q']);
    expect(result.reachedExchanges).toEqual(['a', 'b', 'c']);
    expect(result.loops).toEqual([{ exchanges: ['a', 'b', 'c'] }]);
    expect(result.exact).toBe(true);
  });

  it('M1-02 AC-8 a self loop and a loop through an alternate exchange are reported', () => {
    const t = topology(
      [
        exchange('s', 'fanout'),
        exchange('p', 'direct', { alternateExchange: 'q2x' }),
        exchange('q2x', 'direct', { alternateExchange: 'p' }),
      ],
      ['q'],
      [bindX('s', 's'), bind('s', 'q'), bindX('s', 'p', 'k')],
    );
    const result = simulate(t, { exchange: 's', routingKey: '' });
    expect(result.queues).toEqual(['q']);
    expect(result.loops.map((loop) => loop.exchanges)).toEqual([
      ['p', 'q2x'],
      ['s'],
    ]);
  });
});

describe('simulate: unknown exchange types', () => {
  const unknown = [
    ['x-consistent-hash', 'hash-single-destination'],
    ['x-modulus-hash', 'hash-single-destination'],
    ['x-random', 'random-single-destination'],
    ['x-local-random', 'random-single-destination'],
    ['x-delayed-message', 'delayed'],
    ['x-recent-history', 'recent-history'],
    ['x-made-up', 'unmodelled'],
  ] as const;

  it.each(unknown)(
    'M1-02 AC-9 %s is not guessed: listed with hint %s, the answer is a lower bound',
    (type, hint) => {
      const t = topology(
        [
          exchange('f', 'fanout'),
          exchange('u', type, { alternateExchange: 'ae' }),
          exchange('ae', 'fanout'),
        ],
        ['q1', 'q2', 'q-ae'],
        [bindX('f', 'u'), bind('f', 'q1'), bind('u', 'q2'), bind('ae', 'q-ae')],
      );
      const mixed = simulate(t, { exchange: 'f', routingKey: '' });
      expect(mixed.queues).toEqual(['q1']);
      expect(mixed).toMatchObject({
        outcome: 'routed',
        exact: false,
        unroutable: false,
      });
      expect(mixed.unknownExchanges).toEqual([
        { exchange: 'u', type, hint, alternateExchange: 'ae' },
      ]);
      // its own bindings and its AE are not followed
      expect(mixed.reachedExchanges).toEqual(['f', 'u']);

      const alone = simulate(t, { exchange: 'u', routingKey: '' });
      expect(alone).toMatchObject({
        outcome: 'indeterminate',
        fate: 'unknown',
        unroutable: false,
        exact: false,
        queues: [],
      });
    },
  );
});

describe('simulate: refusals and outcomes', () => {
  const t = topology(
    [exchange('d'), exchange('hidden', 'fanout', { internal: true })],
    ['q'],
    [bind('d', 'q', 'k'), bindX('d', 'hidden', 'via'), bind('hidden', 'q')],
  );

  it('M1-02 AC-11 an unknown exchange is refused with 404 and an internal one with 403', () => {
    expect(simulate(t, { exchange: 'nope', routingKey: 'k' })).toMatchObject({
      outcome: 'refused',
      refusal: { code: 'exchange-not-found', replyCode: 404 },
      queues: [],
      unroutable: false,
    });
    expect(simulate(t, { exchange: 'hidden', routingKey: 'k' })).toMatchObject({
      outcome: 'refused',
      refusal: { code: 'internal-exchange', replyCode: 403 },
    });
  });

  it('M1-02 AC-11 an internal exchange is reachable by E2E', () => {
    expect(simulate(t, { exchange: 'd', routingKey: 'via' }).queues).toEqual([
      'q',
    ]);
  });

  it('M1-02 AC-11 no matching binding is unroutable, returned when mandatory and dropped otherwise', () => {
    expect(simulate(t, { exchange: 'd', routingKey: 'x' })).toMatchObject({
      outcome: 'unroutable',
      fate: 'dropped',
      unroutable: true,
      exact: true,
    });
    expect(
      simulate(t, { exchange: 'd', routingKey: 'x', mandatory: true }),
    ).toMatchObject({ outcome: 'unroutable', fate: 'returned' });
  });

  it('M1-02 AC-12 a duplicated exchange name keeps the first entry and is noted', () => {
    const dup = topology(
      [exchange('d', 'direct'), exchange('d', 'fanout')],
      ['q'],
      [bind('d', 'q', 'k')],
    );
    const result = simulate(dup, { exchange: 'd', routingKey: 'other' });
    expect(result.queues).toEqual([]);
    expect(result.notes).toContainEqual({
      code: 'duplicate-exchange',
      exchange: 'd',
    });
  });

  it('M1-02 AC-12 does not mutate a deeply frozen input and answers the same twice', () => {
    const frozen = deepFreeze(
      topology(
        [
          exchange('t', 'topic', { alternateExchange: 'ae' }),
          exchange('ae', 'fanout'),
        ],
        ['q1', 'q2'],
        [bind('t', 'q1', 'a.#'), bind('ae', 'q2')],
      ),
    );
    const publish = deepFreeze({
      exchange: 't',
      routingKey: 'b',
      headers: { CC: ['a.b'], BCC: [] },
    });
    const first = simulate(frozen, publish);
    expect(first.queues).toEqual(['q1']);
    expect(simulate(frozen, publish)).toEqual(first);
  });
});
