import { describe, expect, it } from 'vitest';

import { findDlxLoops } from './cycles.ts';
import {
  bind,
  bindX,
  deepFreeze,
  exchange,
  expiring,
  queue,
  topologyOf,
} from './testing.ts';

const ring = (rejectable: boolean) =>
  topologyOf(
    [exchange('x'), exchange('y')],
    [expiring('a', 'x', 'k1'), expiring('b', 'y', 'k2', { rejectable })],
    [bind('x', 'b', 'k1'), bind('y', 'a', 'k2')],
  );

describe('dead-letter loops', () => {
  it('M1-03 AC-2 dlx a ring with no rejectable queue is a drop loop', () => {
    const result = findDlxLoops(deepFreeze(ring(false)));
    expect(result.loops).toEqual([
      { queues: ['a', 'b'], kind: 'drop-loop', possible: false },
    ]);
    expect(result.unresolved).toEqual([]);
  });

  it('M1-03 AC-2 dlx a ring with a rejectable queue is a retry ring', () => {
    expect(findDlxLoops(ring(true)).loops).toEqual([
      { queues: ['a', 'b'], kind: 'retry-ring', possible: false },
    ]);
  });

  it('M1-03 AC-3 dlx a queue that dead-letters into itself is a loop of one, directly or through E2E', () => {
    const direct = topologyOf(
      [exchange('x')],
      [expiring('s', 'x', 's')],
      [bind('x', 's', 's')],
    );
    expect(findDlxLoops(direct).loops).toEqual([
      { queues: ['s'], kind: 'drop-loop', possible: false },
    ]);
    const chained = topologyOf(
      [exchange('x1', 'fanout'), exchange('x2', 'fanout')],
      [expiring('s', 'x1')],
      [bindX('x1', 'x2'), bind('x2', 's')],
    );
    expect(findDlxLoops(chained).loops).toEqual([
      { queues: ['s'], kind: 'drop-loop', possible: false },
    ]);
  });

  it('M1-03 AC-2 dlx a line of queues has no loop; a queue that cannot die or has an unknown setting draws no edge', () => {
    const t = topologyOf(
      [exchange('x', 'fanout')],
      [
        expiring('a', 'x'),
        // "inert" has a dead-letter exchange but nothing can make it dead-letter.
        queue('inert', { deadLetter: { status: 'set', exchange: 'x' } }),
        queue('unknown', {
          messageTtlMs: 5,
          deadLetter: { status: 'unknown' },
        }),
      ],
      [bind('x', 'inert'), bind('x', 'unknown'), bind('x', 'a')],
    );
    // "a" feeds itself through the fanout, so it is the only loop.
    expect(findDlxLoops(t).loops.map((l) => l.queues)).toEqual([['a']]);
    const noSelf = topologyOf(
      [exchange('x', 'fanout')],
      [
        expiring('a', 'x'),
        queue('inert', { deadLetter: { status: 'set', exchange: 'x' } }),
      ],
      [bind('x', 'inert')],
    );
    expect(findDlxLoops(noSelf).loops).toEqual([]);
  });

  it('M1-03 AC-2 dlx loops are listed sorted, a three-ring is one loop, and open keys make the loop possible', () => {
    const t = topologyOf(
      [
        exchange('p', 'fanout'),
        exchange('q', 'fanout'),
        exchange('r', 'fanout'),
        exchange('d'),
      ],
      [
        expiring('c', 'p'),
        expiring('a', 'q'),
        expiring('b', 'r'),
        expiring('z', 'd'),
      ],
      [
        bind('p', 'a'),
        bind('q', 'b'),
        bind('r', 'c'),
        // d is a direct exchange and z has no fixed key: z -> z is only possible.
        bind('d', 'z', 'whatever'),
      ],
    );
    expect(findDlxLoops(t).loops).toEqual([
      { queues: ['a', 'b', 'c'], kind: 'drop-loop', possible: false },
      { queues: ['z'], kind: 'drop-loop', possible: true },
    ]);
  });

  it('M1-03 AC-4 dlx a queue that dead-letters into the default exchange with open keys is unresolved, not guessed', () => {
    const t = topologyOf(
      [],
      [expiring('open', ''), expiring('fixed', '', 'fixed')],
      [],
    );
    const result = findDlxLoops(t);
    expect(result.unresolved).toEqual(['open']);
    expect(result.loops).toEqual([
      { queues: ['fixed'], kind: 'drop-loop', possible: false },
    ]);
  });
});
