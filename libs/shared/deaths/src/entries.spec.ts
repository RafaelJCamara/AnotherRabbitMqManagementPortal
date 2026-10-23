import { describe, expect, it } from 'vitest';
import { readDeathEntries } from './entries.ts';
import { LIMITS } from './limits.ts';
import { death, typed, x091, x10, type Death } from './testing/shapes.ts';
import type { DeathMessage } from './types.ts';

// Newest first, as the broker sends them: the pair that died last comes first.
const HISTORY: readonly Death[] = [
  death({
    queue: 'orders.retry',
    reason: 'expired',
    firstSec: 1_700_000_300,
    ttlMs: 60000,
    exchange: 'orders.dlx',
    routingKeys: ['orders.work'],
  }),
  death({ queue: 'orders.work', reason: 'rejected', firstSec: 1_700_000_100 }),
  death({
    queue: 'billing.in',
    reason: 'maxlen',
    firstSec: 1_700_000_000,
    exchange: '',
    routingKeys: ['billing.in'],
  }),
];

const m091 = (xDeath: unknown): DeathMessage => ({
  protocol: 'amqp091',
  headers: { 'x-death': xDeath },
});
const m10 = (xOptDeaths: unknown): DeathMessage => ({
  protocol: 'amqp10',
  messageAnnotations: { 'x-opt-deaths': xOptDeaths },
});

describe('readDeathEntries: one model for both protocols', () => {
  it('M1-04 AC-1 reads a 0-9-1 x-death (seconds) and a 1.0 x-opt-deaths (ms) of the same history as the same entries, newest first, in ms', () => {
    const a = readDeathEntries(m091(x091(HISTORY)));
    const b = readDeathEntries(m10(x10(HISTORY)));
    expect(a.entries).toEqual(b.entries);
    expect(a.entries.map((e) => e.queue)).toEqual([
      'orders.retry',
      'orders.work',
      'billing.in',
    ]);
    expect(a.entries.map((e) => e.firstTimeMs)).toEqual([
      1_700_000_300_000, 1_700_000_100_000, 1_700_000_000_000,
    ]);
    expect(a.entries[0]).toMatchObject({
      reason: 'expired',
      count: 1,
      exchange: 'orders.dlx',
      routingKeys: ['orders.work'],
      originalTtlMs: 60000,
      lastTimeMs: 1_700_000_300_000,
      flags: [],
    });
    // The empty exchange is the default exchange, a real value, not a missing one.
    expect(a.entries[2]?.exchange).toBe('');
    expect(a.source).toBe('x-death');
    expect(b.source).toBe('x-opt-deaths');
    expect(a.provenance).toEqual(['x-death']);
    expect(b.provenance).toEqual(['x-opt-deaths']);
  });

  it('M1-04 AC-1 reads the engine typed form, a Map and a plain table alike', () => {
    const plain = readDeathEntries(m091(x091(HISTORY)));
    const viaTyped = readDeathEntries({
      protocol: 'amqp091',
      headers: { 'x-death': typed(x091(HISTORY)) },
    });
    const viaMap = readDeathEntries({
      protocol: 'amqp10',
      messageAnnotations: new Map([['x-opt-deaths', x10(HISTORY)]]),
    });
    expect(viaTyped.entries).toEqual(plain.entries);
    expect(viaMap.entries).toEqual(plain.entries);
  });

  it('M1-04 AC-1 knows the last death of a 0-9-1 record only when it died once, and says so', () => {
    const twice = death({
      count: 3,
      firstSec: 1_700_000_000,
      lastSec: 1_700_000_900,
    });
    const a = readDeathEntries(m091(x091([twice])));
    const b = readDeathEntries(m10(x10([twice])));
    expect(a.entries[0]).toMatchObject({
      count: 3,
      firstTimeMs: 1_700_000_000_000,
      lastTimeMs: null,
      flags: ['last-time-unavailable'],
    });
    expect(b.entries[0]).toMatchObject({
      count: 3,
      firstTimeMs: 1_700_000_000_000,
      lastTimeMs: 1_700_000_900_000,
      flags: [],
    });
  });
});

describe('readDeathEntries: order', () => {
  it('M1-04 AC-7 sorts a 1.0 list newest first by last-time, stably, and reports it', () => {
    const list = [
      death({ queue: 'a', firstSec: 10, lastSec: 10 }),
      death({ queue: 'b', firstSec: 5, lastSec: 30 }),
      death({ queue: 'c', firstSec: 6, lastSec: 10 }),
    ];
    const result = readDeathEntries(m10(x10(list)));
    expect(result.entries.map((e) => e.queue)).toEqual(['b', 'a', 'c']);
    // The position in the list the client sent survives the sort.
    expect(result.entries.map((e) => e.index)).toEqual([1, 0, 2]);
    expect(result.orderBasis).toBe('last-time');
    expect(result.flags).toEqual(['reordered']);
  });

  it('M1-04 AC-7 does not report a 1.0 list that is already in order', () => {
    const result = readDeathEntries(m10(x10(HISTORY)));
    expect(result.orderBasis).toBe('last-time');
    expect(result.flags).toEqual([]);
  });

  it('M1-04 AC-7 keeps the broker order of a 0-9-1 list, because time is the first death of the pair', () => {
    // The pair that died last (b) first died before a: ascending first-death times are legal.
    const list = [
      death({ queue: 'b', count: 4, firstSec: 100 }),
      death({ queue: 'a', count: 1, firstSec: 200 }),
    ];
    const result = readDeathEntries(m091(x091(list)));
    expect(result.entries.map((e) => e.queue)).toEqual(['b', 'a']);
    expect(result.orderBasis).toBe('broker-order');
    expect(result.flags).toEqual([]);
  });

  it('M1-04 AC-7 does not sort a 1.0 list when a last-time is unusable', () => {
    const list = x10([death({ queue: 'a' }), death({ queue: 'b' })]);
    (list[1] as Record<string, unknown>)['last-time'] = 'soon';
    const result = readDeathEntries(m10(list));
    expect(result.entries.map((e) => e.queue)).toEqual(['a', 'b']);
    expect(result.orderBasis).toBe('broker-order');
    expect(result.entries[1]?.flags).toContain('last-time-invalid');
  });
});

describe('readDeathEntries: which form, and when there is none', () => {
  it('M1-04 AC-5 says none for a message without a death header, whatever the container', () => {
    for (const message of [
      { protocol: 'amqp091' },
      { protocol: 'amqp091', headers: {} },
      { protocol: 'amqp091', headers: 'text' },
      { protocol: 'amqp10', messageAnnotations: null },
    ] as DeathMessage[]) {
      const result = readDeathEntries(message);
      expect(result).toMatchObject({
        state: 'none',
        entries: [],
        source: null,
      });
    }
  });

  it('M1-04 AC-5 reads the other form when the native one is absent, and reports it', () => {
    const result = readDeathEntries({
      protocol: 'amqp091',
      headers: { 'x-opt-deaths': x10(HISTORY) },
    });
    expect(result.entries).toHaveLength(3);
    expect(result.source).toBe('x-opt-deaths');
    expect(result.flags).toEqual(['foreign-form']);
  });

  it('M1-04 AC-5 reads the native form when both are present, and reports it', () => {
    const result = readDeathEntries({
      protocol: 'amqp091',
      headers: {
        'x-death': x091(HISTORY.slice(0, 1)),
        'x-opt-deaths': x10(HISTORY),
      },
    });
    expect(result.entries).toHaveLength(1);
    expect(result.flags).toEqual(['both-forms-present']);
    expect(result.provenance).toEqual(['x-death', 'x-opt-deaths']);
  });

  it('M1-04 AC-5 keeps a death field that is not an array as present, empty and flagged', () => {
    const result = readDeathEntries(m091('rejected'));
    expect(result).toMatchObject({
      state: 'present',
      entries: [],
      source: 'x-death',
    });
    expect(result.flags).toEqual(['death-field-wrong-type']);
  });

  it('M1-04 AC-5 refuses a message that names no protocol, without throwing', () => {
    const result = readDeathEntries({
      protocol: 'stomp',
    } as unknown as DeathMessage);
    expect(result).toMatchObject({ state: 'unreadable', entries: [] });
    expect(result.flags).toContain('read-error');
  });
});

describe('readDeathEntries: bounds', () => {
  it('M1-04 AC-6 keeps the first entries and counts the rest', () => {
    const many = Array.from({ length: LIMITS.maxEntries + 72 }, (_, i) =>
      death({ queue: `q${String(i)}` }),
    );
    const result = readDeathEntries(m091(x091(many)));
    expect(result.entries).toHaveLength(LIMITS.maxEntries);
    expect(result.entries[0]?.queue).toBe('q0');
    expect(result.truncation).toEqual({
      entriesDropped: 72,
      routingKeysDropped: 0,
      textsTruncated: 0,
    });
    expect(result.flags).toEqual(['truncated']);
  });

  it('M1-04 AC-6 keeps the first routing keys of a record and counts the rest', () => {
    const keys = Array.from(
      { length: LIMITS.maxRoutingKeys + 68 },
      (_, i) => `k${String(i)}`,
    );
    const result = readDeathEntries(m091(x091([death({ routingKeys: keys })])));
    expect(result.entries[0]?.routingKeys).toHaveLength(LIMITS.maxRoutingKeys);
    expect(result.entries[0]?.flags).toEqual(['routing-keys-truncated']);
    expect(result.truncation.routingKeysDropped).toBe(68);
  });

  it('M1-04 AC-6 cuts a long name, flags the record and counts it', () => {
    const result = readDeathEntries(
      m091(x091([death({ queue: 'q'.repeat(LIMITS.maxTextChars + 1) })])),
    );
    expect(result.entries[0]?.queue).toHaveLength(LIMITS.maxTextChars);
    expect(result.entries[0]?.flags).toEqual(['text-truncated']);
    expect(result.truncation.textsTruncated).toBe(1);
  });

  it('M1-04 AC-6 spends one text budget over the whole history', () => {
    const wide = Array.from({ length: LIMITS.maxEntries }, () =>
      death({
        queue: 'q'.repeat(LIMITS.maxTextChars),
        exchange: 'e'.repeat(LIMITS.maxTextChars),
      }),
    );
    const result = readDeathEntries(m091(x091(wide)));
    const chars = result.entries.reduce(
      (sum, e) =>
        sum +
        (e.queue?.length ?? 0) +
        (e.exchange?.length ?? 0) +
        (e.reason?.length ?? 0) +
        e.routingKeys.reduce((n, k) => n + k.length, 0),
      0,
    );
    expect(chars).toBeLessThanOrEqual(LIMITS.maxTotalChars);
    expect(result.truncation.textsTruncated).toBeGreaterThan(0);
  });

  it('M1-04 AC-6 does only bounded work for an array that claims 2^32 items', () => {
    const sparse: unknown[] = x091([death()]);
    sparse.length = 2 ** 32 - 1;
    const result = readDeathEntries(m091(sparse));
    expect(result.entries).toHaveLength(LIMITS.maxEntries);
    expect(result.truncation.entriesDropped).toBe(
      2 ** 32 - 1 - LIMITS.maxEntries,
    );
    expect(result.entries[1]?.flags).toContain('not-a-table');
  });
});
