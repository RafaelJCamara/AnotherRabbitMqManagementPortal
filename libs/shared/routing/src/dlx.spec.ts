import { describe, expect, it } from 'vitest';

import { deadLetterPath, indexDeadLetters, routeDeadLetter } from './dlx.ts';
import type { PathEnd } from './dlx.ts';
import {
  bind,
  bindX,
  deepFreeze,
  exchange,
  expiring,
  queue,
  topologyOf,
} from './testing.ts';
import { resolveDlxLimits, newDlxTruncation } from './dlx.ts';

const ends = (ends: readonly { end: PathEnd }[]): string[] =>
  ends.map((p) => p.end.kind).sort();

describe('dead-letter paths', () => {
  it('M1-03 AC-2 dlx a two-queue ring with no rejectable queue drops the message where it closes', () => {
    const t = deepFreeze(
      topologyOf(
        [exchange('x'), exchange('y')],
        [expiring('a', 'x', 'k1'), expiring('b', 'y', 'k2')],
        [bind('x', 'b', 'k1'), bind('y', 'a', 'k2')],
      ),
    );
    const result = deadLetterPath(t, 'a');
    expect(result.startFound).toBe(true);
    expect(result.reached).toEqual(['b']);
    expect(result.paths).toHaveLength(1);
    const [path] = result.paths;
    expect(path?.end).toEqual({ kind: 'dropped-cycle', queue: 'b' });
    expect(
      path?.steps.map((s) => [
        s.from,
        s.targets.map((x) => x.queue),
        s.dropped,
      ]),
    ).toEqual([
      ['a', ['b'], []],
      ['b', [], ['a']],
    ]);
    expect(result.exact).toBe(true);
  });

  it('M1-03 AC-2 dlx a rejectable queue lets the ring go on for a rejected message', () => {
    const t = topologyOf(
      [exchange('x'), exchange('y')],
      [
        expiring('a', 'x', 'k1'),
        expiring('b', 'y', 'k2', { rejectable: true }),
      ],
      [bind('x', 'b', 'k1'), bind('y', 'a', 'k2')],
    );
    const result = deadLetterPath(t, 'a');
    // a expires -> b; b expires -> a is dropped; b rejects -> a is delivered.
    expect(result.reached).toEqual(['a', 'b']);
    expect(ends(result.paths)).toContain('dropped-cycle');
  });

  it('M1-03 AC-2 dlx a first death by rejection is never checked for a cycle', () => {
    const t = topologyOf(
      [exchange('x')],
      [
        queue('s', {
          rejectable: true,
          deadLetter: { status: 'set', exchange: 'x', routingKey: 's' },
        }),
      ],
      [bind('x', 's', 's')],
    );
    const rejected = deadLetterPath(t, 's', { reason: 'rejected' });
    expect(rejected.reached).toEqual(['s']);
    const expired = deadLetterPath(t, 's', { reason: 'expired' });
    expect(expired.reached).toEqual([]);
    expect(expired.paths[0]?.end.kind).toBe('dropped-cycle');
  });

  it('M1-03 AC-3 dlx a queue that dead-letters into itself is dropped on the first lap, also through an E2E chain', () => {
    const direct = topologyOf(
      [exchange('x')],
      [expiring('s', 'x', 's')],
      [bind('x', 's', 's')],
    );
    expect(deadLetterPath(direct, 's').paths[0]?.end).toEqual({
      kind: 'dropped-cycle',
      queue: 's',
    });
    const chained = topologyOf(
      [exchange('x1', 'fanout'), exchange('x2', 'fanout')],
      [expiring('s', 'x1')],
      [bindX('x1', 'x2'), bind('x2', 's')],
    );
    const result = deadLetterPath(chained, 's');
    expect(result.reached).toEqual([]);
    expect(result.paths[0]?.end.kind).toBe('dropped-cycle');
    expect(result.paths[0]?.steps[0]?.targets).toEqual([]);
    expect(result.paths[0]?.steps[0]?.dropped).toEqual(['s']);
  });

  it('M1-03 AC-4 dlx a fixed routing key replaces the message keys and the walk is exact', () => {
    const t = topologyOf(
      [exchange('x'), exchange('t', 'topic')],
      [
        expiring('src', 'x', 'k1'),
        queue('q1'),
        queue('q2'),
        expiring('src2', 't', 'a.b'),
        queue('q3'),
      ],
      [
        bind('x', 'q1', 'k1'),
        bind('x', 'q2', 'k2'),
        bind('t', 'q3', 'a.*'),
        bind('t', 'q1', 'z'),
      ],
    );
    const direct = deadLetterPath(t, 'src', { keys: ['k2'] });
    expect(direct.paths[0]?.steps[0]?.keys).toEqual(['k1']);
    expect(direct.reached).toEqual(['q1']);
    expect(direct.exact).toBe(true);
    const topic = deadLetterPath(t, 'src2');
    expect(topic.reached).toEqual(['q3']);
    expect(topic.paths[0]?.steps[0]?.targets[0]?.certainty).toBe('definite');
  });

  it('M1-03 AC-4 dlx without a fixed key the caller keys are used, and open keys give a possible set', () => {
    const t = topologyOf(
      [exchange('x'), exchange('f', 'fanout')],
      [expiring('src', 'x'), expiring('srcf', 'f'), queue('q1'), queue('q2')],
      [
        bind('x', 'q1', 'k1'),
        bind('x', 'q2', 'k2'),
        bind('f', 'q1'),
        bind('f', 'q2'),
      ],
    );
    const known = deadLetterPath(t, 'src', { keys: ['k2'] });
    expect(known.reached).toEqual(['q2']);
    expect(known.paths[0]?.steps[0]?.keys).toEqual(['k2']);
    expect(known.exact).toBe(true);

    const open = deadLetterPath(t, 'src');
    expect(open.paths[0]?.steps[0]?.keys).toBe('original');
    expect(open.reached).toEqual(['q1', 'q2']);
    expect(open.paths[0]?.steps[0]?.targets.map((x) => x.certainty)).toEqual([
      'possible',
      'possible',
    ]);
    expect(open.exact).toBe(false);

    // A fanout exchange ignores keys: its targets are certain even with open keys.
    const fanout = deadLetterPath(t, 'srcf');
    expect(fanout.reached).toEqual(['q1', 'q2']);
    expect(fanout.paths[0]?.steps[0]?.targets.map((x) => x.certainty)).toEqual([
      'definite',
      'definite',
    ]);
    expect(fanout.exact).toBe(true);
  });

  it('M1-03 AC-4 dlx the default exchange with a fixed key routes to the queue of that name; with open keys the answer is indeterminate', () => {
    const t = topologyOf(
      [],
      [expiring('src', '', 'q1'), expiring('open', ''), queue('q1')],
      [],
    );
    expect(deadLetterPath(t, 'src').reached).toEqual(['q1']);
    const open = deadLetterPath(t, 'open');
    expect(open.paths[0]?.end).toEqual({
      kind: 'indeterminate',
      queue: 'open',
      why: 'open-default-exchange',
    });
    expect(open.exact).toBe(false);
  });

  it('M1-03 AC-4 dlx an internal dead-letter exchange is a valid target (the 403 is a channel check)', () => {
    const t = topologyOf(
      [exchange('x', 'direct', { internal: true })],
      [expiring('src', 'x', 'k'), queue('q')],
      [bind('x', 'q', 'k')],
    );
    expect(deadLetterPath(t, 'src').reached).toEqual(['q']);
  });

  it('M1-03 AC-4 dlx a missing dead-letter exchange drops the message and a silent exchange is unroutable', () => {
    const missing = topologyOf([], [expiring('src', 'nope', 'k')], []);
    expect(deadLetterPath(missing, 'src').paths[0]?.end).toEqual({
      kind: 'dropped-missing-exchange',
      exchange: 'nope',
    });
    const silent = topologyOf(
      [exchange('x')],
      [expiring('src', 'x', 'k'), queue('q')],
      [bind('x', 'q', 'other')],
    );
    expect(deadLetterPath(silent, 'src').paths[0]?.end).toEqual({
      kind: 'dropped-unroutable',
      exchange: 'x',
    });
  });

  it('M1-03 AC-4 dlx the dead-letter exchange alternate exchange catches an unmatched dead letter', () => {
    const t = topologyOf(
      [
        exchange('x', 'direct', { alternateExchange: 'ae' }),
        exchange('ae', 'fanout'),
      ],
      [expiring('src', 'x', 'nomatch'), queue('catch')],
      [bind('ae', 'catch')],
    );
    const result = deadLetterPath(t, 'src');
    expect(result.reached).toEqual(['catch']);
    expect(result.paths[0]?.steps[0]?.targets[0]?.via).toEqual(['x', 'ae']);
  });

  it('M1-03 AC-9 dlx start problems: an unknown queue, no dead-letter exchange, an unreadable setting, a queue that cannot die', () => {
    const t = topologyOf(
      [exchange('x')],
      [
        queue('plain'),
        queue('unknown', {
          messageTtlMs: 5,
          deadLetter: { status: 'unknown' },
        }),
        queue('inert', {
          deadLetter: { status: 'set', exchange: 'x', routingKey: 'k' },
        }),
      ],
      [],
    );
    expect(deadLetterPath(t, 'ghost')).toMatchObject({
      startFound: false,
      paths: [],
      exact: false,
    });
    expect(
      deadLetterPath(t, 'plain', { reason: 'expired' }).paths[0]?.end,
    ).toEqual({
      kind: 'dropped-no-dead-letter',
      queue: 'plain',
    });
    const unknown = deadLetterPath(t, 'unknown');
    expect(unknown.paths[0]?.end).toEqual({
      kind: 'indeterminate',
      queue: 'unknown',
      why: 'dead-letter-unknown',
    });
    expect(unknown.exact).toBe(false);
    // Nothing can make "inert" die, so there is no path unless a reason is asked for.
    expect(deadLetterPath(t, 'inert').paths).toEqual([]);
    expect(
      deadLetterPath(t, 'inert', { reason: 'expired' }).paths[0]?.end.kind,
    ).toBe('dropped-unroutable');
  });

  it('M1-03 AC-9 dlx a chain, a diamond and a fan-out: each (queue, deaths) state once, the first path to a queue is a shortest one', () => {
    const t = topologyOf(
      [
        exchange('x', 'fanout'),
        exchange('y', 'fanout'),
        exchange('z', 'fanout'),
      ],
      [
        expiring('q0', 'x'),
        expiring('q1', 'y'),
        expiring('q2', 'y'),
        expiring('q3', 'z'),
        queue('end'),
      ],
      [bind('x', 'q1'), bind('x', 'q2'), bind('y', 'q3'), bind('z', 'end')],
    );
    const result = deadLetterPath(t, 'q0');
    expect(result.reached).toEqual(['end', 'q1', 'q2', 'q3']);
    // q1 and q2 both reach q3, but with different deaths behind them (the cycle rule depends on
    // them), so the walk keeps two states of q3 and two paths to "end"; the first is a shortest one.
    const toEnd = result.paths.filter(
      (p) => p.end.kind === 'terminal' && p.end.queue === 'end',
    );
    expect(toEnd.map((p) => p.steps.map((s) => s.from))).toEqual([
      ['q0', 'q1', 'q3'],
      ['q0', 'q2', 'q3'],
    ]);
    expect(result.exact).toBe(true);
  });

  it('M1-03 AC-5 dlx a consistent-hash dead-letter exchange gives possible targets and an inexact answer', () => {
    const t = topologyOf(
      [exchange('h', 'x-consistent-hash')],
      [expiring('src', 'h', 'k'), queue('a'), queue('b')],
      [bind('h', 'a', '10'), bind('h', 'b', '10')],
    );
    const result = deadLetterPath(t, 'src');
    expect(result.reached).toEqual(['a', 'b']);
    const step = result.paths[0]?.steps[0];
    expect(step?.targets.map((x) => x.certainty)).toEqual([
      'possible',
      'possible',
    ]);
    expect(step?.shares[0]).toMatchObject({
      code: 'non-deterministic-share',
      candidates: ['a', 'b'],
    });
    expect(step?.unknownExchanges[0]?.hint).toBe('hash-single-destination');
    expect(result.exact).toBe(false);
  });

  it('M1-03 AC-4 dlx the strategy of the source is carried on the step', () => {
    const t = topologyOf(
      [exchange('x')],
      [
        queue('src', {
          type: 'quorum',
          messageTtlMs: 1,
          deadLetter: {
            status: 'set',
            exchange: 'x',
            routingKey: 'k',
            strategy: 'at-least-once',
          },
        }),
        queue('dest'),
      ],
      [bind('x', 'dest', 'k')],
    );
    expect(deadLetterPath(t, 'src').paths[0]?.steps[0]?.strategy).toBe(
      'at-least-once',
    );
  });

  it('M1-03 AC-4 dlx the kept keys travel: a fixed key of one hop is the key of the next', () => {
    const t = topologyOf(
      [exchange('x'), exchange('y')],
      [
        expiring('a', 'x', 'k1'),
        expiring('b', 'y'),
        queue('hit'),
        queue('miss'),
      ],
      [
        bind('x', 'b', 'k1'),
        bind('y', 'hit', 'k1'),
        bind('y', 'miss', 'other'),
      ],
    );
    // b has no fixed key, so it keeps the key the message had: k1 (set by a's fixed key).
    const result = deadLetterPath(t, 'a');
    expect(result.reached).toEqual(['b', 'hit']);
    expect(result.exact).toBe(true);
  });

  it('M1-03 AC-4 dlx routeDeadLetter reports no dead letter, an unknown setting and the strategy', () => {
    const t = topologyOf(
      [exchange('x')],
      [queue('p'), queue('u', { deadLetter: { status: 'unknown' } })],
      [],
    );
    const index = indexDeadLetters(t);
    const limits = resolveDlxLimits();
    const acc = newDlxTruncation();
    expect(routeDeadLetter(index, queue('p'), null, limits, acc)).toEqual({
      kind: 'no-dead-letter',
    });
    expect(
      routeDeadLetter(
        index,
        queue('u', { deadLetter: { status: 'unknown' } }),
        null,
        limits,
        acc,
      ),
    ).toEqual({ kind: 'unknown-setting' });
  });
});
