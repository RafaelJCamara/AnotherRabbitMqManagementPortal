import { describe, expect, it } from 'vitest';

import { createLogTail } from './log-tail.ts';

describe('the log tail', () => {
  it('keeps each line without its newline, newest last', () => {
    const tail = createLogTail();

    tail.add('{"n":1}\n');
    tail.add('{"n":2}\n');

    expect(tail.tail(10)).toEqual({
      lines: ['{"n":1}', '{"n":2}'],
      held: 2,
      dropped: 0,
    });
  });

  it('returns at most the newest lines asked for, and none for zero', () => {
    const tail = createLogTail();
    for (const n of [1, 2, 3, 4]) tail.add(`l${String(n)}\n`);

    expect(tail.tail(2).lines).toEqual(['l3', 'l4']);
    expect(tail.tail(2).held).toBe(4);
    expect(tail.tail(0).lines).toEqual([]);
    expect(tail.tail(-1).lines).toEqual([]);
  });

  it('is bounded by lines and counts what it evicts (I-6, I-13)', () => {
    const tail = createLogTail({ maxItems: 3 });
    for (let n = 1; n <= 10; n += 1) tail.add(`line ${String(n)}\n`);

    expect(tail.tail(100)).toEqual({
      lines: ['line 8', 'line 9', 'line 10'],
      held: 3,
      dropped: 7,
    });
  });

  it('is bounded by bytes, and a line larger than the ring is dropped and counted', () => {
    const tail = createLogTail({ maxBytes: 20 });

    tail.add('x'.repeat(10));
    tail.add('a'.repeat(15));
    tail.add('b'.repeat(50));

    expect(tail.tail(10)).toEqual({
      lines: ['a'.repeat(15)],
      held: 1,
      dropped: 2,
    });
  });
});
