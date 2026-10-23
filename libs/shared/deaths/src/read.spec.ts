import { describe, expect, it } from 'vitest';
import { LIMITS } from './limits.ts';
import {
  field,
  newContext,
  peel,
  readArray,
  readInteger,
  readText,
  readTimeMs,
} from './read.ts';

describe('readers: peeling and fields', () => {
  it('M1-04 AC-5 reads plain, typed, amqplib and Map values the same way', () => {
    const ctx = newContext();
    const plain = { queue: 'q' };
    const typed = { t: 'table', v: { queue: { t: 'string', v: 'q' } } };
    const map = new Map([['queue', { '!': 'x', value: 'q' }]]);
    expect(field(ctx, plain, 'queue')).toBe('q');
    expect(field(ctx, typed, 'queue')).toBe('q');
    expect(field(ctx, map, 'queue')).toBe('q');
    expect(peel(ctx, { '!': 'timestamp', value: 5 })).toBe(5);
    expect(ctx.errors).toBe(0);
  });

  it('M1-04 AC-5 reads only own properties, so an inherited name is absent', () => {
    const ctx = newContext();
    expect(field(ctx, {}, 'constructor')).toBeUndefined();
    expect(field(ctx, Object.create({ queue: 'q' }), 'queue')).toBeUndefined();
    expect(field(ctx, [1], 'length')).toBeUndefined();
    expect(field(ctx, 'text', 'length')).toBeUndefined();
  });

  it('M1-04 AC-5 counts a getter or a proxy that throws and reads it as absent', () => {
    const ctx = newContext();
    const hostile = {
      get queue(): string {
        throw new Error('boom');
      },
    };
    expect(field(ctx, hostile, 'queue')).toBeUndefined();
    const proxy = new Proxy(
      {},
      {
        has() {
          throw new Error('trap');
        },
        getOwnPropertyDescriptor() {
          throw new Error('trap');
        },
      },
    );
    expect(field(ctx, proxy, 'queue')).toBeUndefined();
    expect(ctx.errors).toBeGreaterThanOrEqual(2);
  });

  it('M1-04 AC-5 stops peeling a value that wraps itself', () => {
    const ctx = newContext();
    const loop: Record<string, unknown> = { t: 'table' };
    loop.v = loop;
    expect(() => peel(ctx, loop)).not.toThrow();
  });
});

describe('readers: scalars', () => {
  const ctx = newContext();

  it('M1-04 AC-5 reads integers from numbers and bigints and nothing else', () => {
    expect(readInteger(ctx, 7)).toBe(7);
    expect(readInteger(ctx, 7n)).toBe(7);
    expect(readInteger(ctx, { t: 'long', v: 7 })).toBe(7);
    const bad = [1.5, NaN, Infinity, '7', 2n ** 80n, 2 ** 60, null, {}];
    for (const [index, value] of bad.entries()) {
      expect(readInteger(ctx, value), `case ${String(index)}`).toBeNull();
    }
  });

  it('M1-04 AC-5 reads a time in the unit of its form and never guesses the unit', () => {
    expect(readTimeMs(ctx, 1_700_000_000, 'seconds')).toBe(1_700_000_000_000);
    expect(readTimeMs(ctx, 1_700_000_000_000, 'ms')).toBe(1_700_000_000_000);
    expect(readTimeMs(ctx, new Date(1234), 'seconds')).toBe(1234);
    expect(readTimeMs(ctx, { t: 'timestamp', v: 5 }, 'seconds')).toBe(5000);
    // Milliseconds in a seconds field would be the year 55000: refused, not rescaled.
    expect(readTimeMs(ctx, 1_700_000_000_000, 'seconds')).toBeNull();
    const bad = [-1, 1.5, new Date(NaN), 'x', null, 2 ** 70];
    for (const [index, value] of bad.entries()) {
      expect(readTimeMs(ctx, value, 'ms'), `case ${String(index)}`).toBeNull();
    }
  });
});

describe('readers: bounds', () => {
  it('M1-04 AC-6 reads only the first items of an array that claims 2^32', () => {
    const ctx = newContext();
    const sparse: unknown[] = [];
    sparse.length = 2 ** 32 - 1;
    sparse[0] = 'a';
    const read = readArray(ctx, sparse, 5);
    expect(read?.items).toHaveLength(5);
    expect(read?.items[0]).toBe('a');
    expect(read?.total).toBe(2 ** 32 - 1);
    expect(readArray(ctx, 'text', 5)).toBeNull();
    expect(readArray(ctx, { length: 3 }, 5)).toBeNull();
  });

  it('M1-04 AC-6 cuts a text to the limit, counts it and keeps surrogate pairs whole', () => {
    const ctx = newContext();
    const long = 'a'.repeat(LIMITS.maxTextChars + 10);
    const cut = readText(ctx, long);
    expect(cut?.text).toHaveLength(LIMITS.maxTextChars);
    expect(cut?.truncated).toBe(true);
    const pairs = readText(ctx, '\u{1F600}'.repeat(10), 3);
    expect(pairs?.text).toBe('\u{1F600}');
    expect(ctx.textsTruncated).toBe(2);
  });

  it('M1-04 AC-6 decodes bytes, cuts them at the limit and spends one history-wide budget', () => {
    const ctx = newContext();
    const bytes = new TextEncoder().encode('queue-é');
    expect(readText(ctx, bytes)?.text).toBe('queue-é');
    expect(readText(ctx, new Uint8Array([0xff, 0x41]))?.text).toBe('�A');
    expect(readText(ctx, new Uint8Array(40), 8)?.truncated).toBe(true);
    ctx.charsLeft = 3;
    expect(readText(ctx, 'abcdef')).toEqual({ text: 'abc', truncated: true });
    expect(readText(ctx, 'zzz')).toEqual({ text: '', truncated: true });
    expect(readText(ctx, 12)).toBeNull();
  });
});
