import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { dlxSources } from './dlx-sources.ts';
import type { DlxSourcesResult } from './dlx-sources.ts';
import { indexDeadLetters } from './dlx.ts';
import {
  bind,
  deepFreeze,
  exchange,
  expiring,
  queue,
  topologyOf,
} from './testing.ts';
import type { TopologyQueue } from './types.ts';

const quorumSource = (
  name: string,
  exchangeName: string,
  key: string,
  limit: TopologyQueue['deliveryLimit'],
): TopologyQueue =>
  queue(name, {
    type: 'quorum',
    ...(limit === undefined ? {} : { deliveryLimit: limit }),
    deadLetter: { status: 'set', exchange: exchangeName, routingKey: key },
  });

const codes = (result: DlxSourcesResult): string[] =>
  result.unknownReasons.map((r) =>
    r.subject === undefined ? r.code : `${r.code}:${r.subject}`,
  );

describe('DLX sources', () => {
  const base = () =>
    topologyOf(
      [exchange('x')],
      [
        quorumSource('src', 'x', 'dlq', { kind: 'finite', value: 20 }),
        queue('dlq', {
          type: 'quorum',
          deliveryLimit: { kind: 'finite', value: 20 },
        }),
      ],
      [bind('x', 'dlq', 'dlq')],
    );

  it('M1-03 AC-1 dlx a quorum DLQ with L=20 fed by a quorum source with L=20 returns that source with finite 20', () => {
    const result = dlxSources(deepFreeze(base()), 'dlq');
    expect(result).toEqual({
      sources: [
        {
          queue: 'src',
          limit: { kind: 'finite', value: 20 },
          certainty: 'definite',
          via: ['x'],
          reasons: ['delivery_limit', 'rejected'],
        },
      ],
      complete: true,
      unknownReasons: [],
      truncation: { sources: 0, steps: 0, paths: 0, loops: 0, candidates: 0 },
    });
  });

  it('M1-03 AC-7 dlx an empty list is complete only without gaps', () => {
    const t = topologyOf([exchange('x')], [queue('dlq'), queue('lonely')], []);
    expect(dlxSources(t, 'dlq')).toMatchObject({
      sources: [],
      complete: true,
      unknownReasons: [],
    });
    const gaps = dlxSources(t, 'dlq', {
      gaps: [
        'policy-unreadable',
        'operator-policy-unreadable',
        'stats-fields-missing',
        'other-clients-may-declare',
        'policy-unreadable',
      ],
    });
    expect(gaps.sources).toEqual([]);
    expect(gaps.complete).toBe(false);
    expect(codes(gaps)).toEqual([
      'operator-policy-unreadable',
      'other-clients-may-declare',
      'policy-unreadable',
      'stats-fields-missing',
    ]);
  });

  it('M1-03 AC-8 dlx an absent limit is unknown, never unlimited, and makes the answer incomplete', () => {
    const t = base();
    const noLimit = topologyOf(
      t.exchanges,
      [quorumSource('src', 'x', 'dlq', undefined), ...t.queues.slice(1)],
      t.bindings,
    );
    const result = dlxSources(noLimit, 'dlq');
    expect(result.sources[0]?.limit).toEqual({ kind: 'unknown' });
    expect(result.complete).toBe(false);
    expect(codes(result)).toEqual(['source-limit-unknown:src']);

    const unlimited = topologyOf(
      t.exchanges,
      [
        quorumSource('src', 'x', 'dlq', { kind: 'unlimited' }),
        ...t.queues.slice(1),
      ],
      t.bindings,
    );
    expect(dlxSources(unlimited, 'dlq')).toMatchObject({
      complete: true,
      sources: [
        { queue: 'src', limit: { kind: 'unlimited' }, reasons: ['rejected'] },
      ],
    });
  });

  it('M1-03 AC-8 dlx a queue whose dead-letter setting is unreadable is a possible source and an unknown', () => {
    const t = base();
    const withUnknown = topologyOf(
      t.exchanges,
      [...t.queues, queue('mystery', { deadLetter: { status: 'unknown' } })],
      t.bindings,
    );
    const result = dlxSources(withUnknown, 'dlq');
    expect(
      result.sources.map((s) => [s.queue, s.certainty, s.limit.kind]),
    ).toEqual([
      ['mystery', 'possible', 'unknown'],
      ['src', 'definite', 'finite'],
    ]);
    expect(codes(result)).toEqual([
      'dead-letter-unknown:mystery',
      'source-limit-unknown:mystery',
    ]);
    expect(result.complete).toBe(false);
  });

  it('M1-03 AC-8 dlx an exchange the simulator cannot model on a dead-letter route is an unknown and a possible source', () => {
    const t = topologyOf(
      [
        exchange('x'),
        exchange('d', 'x-delayed-message'),
        exchange('rh', 'x-recent-history'),
      ],
      [
        quorumSource('src', 'x', 'dlq', { kind: 'finite', value: 20 }),
        quorumSource('delayed', 'd', 'k', { kind: 'finite', value: 5 }),
        queue('dlq'),
      ],
      [bind('x', 'dlq', 'dlq')],
    );
    const result = dlxSources(t, 'dlq');
    expect(result.sources.map((s) => [s.queue, s.certainty])).toEqual([
      ['delayed', 'possible'],
      ['src', 'definite'],
    ]);
    expect(codes(result)).toEqual(['unknown-exchange-in-path:d']);
  });

  it('M1-03 AC-5 dlx a consistent-hash dead-letter exchange makes every bound queue a possible target of its source', () => {
    const t = topologyOf(
      [exchange('h', 'x-consistent-hash')],
      [
        quorumSource('src', 'h', 'k', { kind: 'finite', value: 20 }),
        queue('a'),
        queue('b'),
      ],
      [bind('h', 'a', '10'), bind('h', 'b', '10')],
    );
    for (const target of ['a', 'b']) {
      const result = dlxSources(t, target);
      expect(result.sources).toMatchObject([
        { queue: 'src', certainty: 'possible' },
      ]);
      // The exchange is modelled as a share, not as an unknown: the answer stays complete.
      expect(result.complete).toBe(true);
    }
    expect(dlxSources(t, 'src').sources).toEqual([]);
  });

  it('M1-03 AC-8 dlx x-death entries naming a queue that is not a known source count as a DLX source (A-2)', () => {
    const t = topologyOf(
      [exchange('x')],
      [
        queue('dlq', { heldDeathSources: ['gone', 'moved', 'src'] }),
        quorumSource('src', 'x', 'dlq', { kind: 'finite', value: 20 }),
        quorumSource('moved', 'x', 'elsewhere', { kind: 'finite', value: 7 }),
      ],
      [bind('x', 'dlq', 'dlq')],
    );
    const result = dlxSources(t, 'dlq');
    expect(result.sources.map((s) => [s.queue, s.certainty, s.limit])).toEqual([
      ['gone', 'possible', { kind: 'unknown' }],
      ['moved', 'possible', { kind: 'finite', value: 7 }],
      ['src', 'definite', { kind: 'finite', value: 20 }],
    ]);
    expect(codes(result)).toEqual([
      'held-death-source-missing:gone',
      'held-death-source-missing:moved',
      'source-limit-unknown:gone',
    ]);
    expect(result.complete).toBe(false);
  });

  it('M1-03 AC-4 dlx a fixed key that misses the target is not a source; open keys make a possible one', () => {
    const t = topologyOf(
      [exchange('x')],
      [
        expiring('fixed-miss', 'x', 'other', {
          deliveryLimit: { kind: 'unlimited' },
        }),
        expiring('fixed-hit', 'x', 'dlq', {
          deliveryLimit: { kind: 'unlimited' },
        }),
        expiring('open', 'x', undefined, {
          deliveryLimit: { kind: 'unlimited' },
        }),
        queue('dlq'),
      ],
      [bind('x', 'dlq', 'dlq')],
    );
    const result = dlxSources(t, 'dlq');
    expect(result.sources.map((s) => [s.queue, s.certainty])).toEqual([
      ['fixed-hit', 'definite'],
      ['open', 'possible'],
    ]);
    expect(result.complete).toBe(true);
  });

  it('M1-03 AC-4 dlx a source on the default exchange with open keys can feed any queue; a missing exchange feeds none', () => {
    const t = topologyOf(
      [],
      [
        expiring('open', '', undefined, {
          deliveryLimit: { kind: 'unlimited' },
        }),
        expiring('broken', 'nope', 'k', {
          deliveryLimit: { kind: 'unlimited' },
        }),
        queue('dlq'),
      ],
      [],
    );
    expect(
      dlxSources(t, 'dlq').sources.map((s) => [s.queue, s.certainty]),
    ).toEqual([['open', 'possible']]);
  });

  it('M1-03 AC-4 dlx a queue that positively cannot dead-letter is not a source; one that may be rejected from is; a queue that feeds itself is', () => {
    const t = topologyOf(
      [exchange('x')],
      [
        queue('inert', {
          rejectable: false,
          deliveryLimit: { kind: 'unlimited' },
          deadLetter: { status: 'set', exchange: 'x', routingKey: 'dlq' },
        }),
        queue('maybe', {
          deliveryLimit: { kind: 'unlimited' },
          deadLetter: { status: 'set', exchange: 'x', routingKey: 'dlq' },
        }),
        expiring('self', 'x', 'self', { deliveryLimit: { kind: 'unlimited' } }),
        queue('dlq'),
      ],
      [bind('x', 'dlq', 'dlq'), bind('x', 'self', 'self')],
    );
    expect(
      dlxSources(t, 'dlq').sources.map((s) => [s.queue, s.reasons]),
    ).toEqual([['maybe', ['rejected']]]);
    expect(dlxSources(t, 'self').sources.map((s) => s.queue)).toEqual(['self']);
  });

  it('M1-03 AC-8 dlx a target that is not in the topology is an unknown, not an empty answer', () => {
    const result = dlxSources(base(), 'ghost');
    expect(result.sources).toEqual([]);
    expect(result.complete).toBe(false);
    expect(codes(result)).toEqual(['target-not-found:ghost']);
  });

  it('M1-03 AC-10 dlx the source scan limit is counted and makes the answer incomplete', () => {
    const t = topologyOf(
      [exchange('x', 'fanout')],
      [
        ...['a', 'b', 'c', 'd', 'e'].map((n) =>
          expiring(n, 'x', undefined, { deliveryLimit: { kind: 'unlimited' } }),
        ),
        queue('dlq'),
      ],
      [bind('x', 'dlq')],
    );
    const result = dlxSources(t, 'dlq', {
      limits: { maxDlxSourcesScanned: 2 },
    });
    // Sorted scan: a, b are examined; c, d, e, dlq are not.
    expect(result.sources.map((s) => s.queue)).toEqual(['a', 'b']);
    expect(result.truncation.sources).toBe(4);
    expect(result.complete).toBe(false);
    expect(codes(result)).toEqual(['truncated']);
  });

  it('M1-03 AC-10 dlx with default limits 5,000 sources are scanned on one shared index and nothing is cut', () => {
    const names = Array.from({ length: 5000 }, (_, i) => `s${String(i)}`);
    const t = topologyOf(
      [exchange('sink', 'fanout')],
      [
        ...names.map((n) =>
          expiring(n, 'sink', undefined, {
            deliveryLimit: { kind: 'unlimited' },
          }),
        ),
        queue('dlq'),
      ],
      [bind('sink', 'dlq')],
    );
    const index = indexDeadLetters(t);
    const started = Date.now();
    const result = dlxSources(index, 'dlq');
    expect(result.sources).toHaveLength(5000);
    expect(result.complete).toBe(true);
    expect(result.truncation.sources).toBe(0);
    expect(result.sources.every((s) => s.certainty === 'definite')).toBe(true);
    console.info(
      `M1-03 dlx 5,000 sources scanned in ${String(Date.now() - started)} ms`,
    );
  });

  it('M1-03 AC-11 dlx the answer does not depend on the order of queues and bindings, and the input is not changed', () => {
    const arrange = fc.infiniteStream(fc.nat());
    fc.assert(
      fc.property(arrange, fc.integer({ min: 0, max: 5 }), (stream, extra) => {
        const t = deepFreeze(
          topologyOf(
            [exchange('x'), exchange('y', 'fanout')],
            [
              quorumSource('s1', 'x', 'dlq', { kind: 'finite', value: 20 }),
              quorumSource('s2', 'y', 'ignored', undefined),
              expiring('s3', 'x', undefined),
              queue('dlq', { heldDeathSources: ['old'] }),
              ...Array.from({ length: extra }, (_, i) =>
                queue(`pad${String(i)}`),
              ),
            ],
            [
              bind('x', 'dlq', 'dlq'),
              bind('y', 'dlq'),
              bind('x', 'pad0', 'zz'),
            ],
          ),
        );
        const it = stream[Symbol.iterator]();
        const shuffle = <T>(items: readonly T[]): T[] => {
          const copy = [...items];
          for (let i = copy.length - 1; i > 0; i -= 1) {
            const j = it.next().value % (i + 1);
            [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
          }
          return copy;
        };
        const shuffled = {
          exchanges: shuffle(t.exchanges),
          queues: shuffle(t.queues),
          bindings: shuffle(t.bindings),
        };
        expect(dlxSources(shuffled, 'dlq')).toEqual(dlxSources(t, 'dlq'));
      }),
      { numRuns: 100 },
    );
  });
});
