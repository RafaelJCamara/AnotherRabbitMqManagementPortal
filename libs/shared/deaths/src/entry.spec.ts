import { describe, expect, it } from 'vitest';
import { readEntry } from './entry.ts';
import { newContext } from './read.ts';
import { X_DEATH } from './x-death.ts';
import { X_OPT_DEATHS } from './x-opt-deaths.ts';
import type { DeathEntry, EntryFlag } from './types.ts';

const GOOD = {
  queue: 'q',
  reason: 'rejected',
  count: 1,
  exchange: 'x',
  'routing-keys': ['k'],
  time: 1000,
};

interface Case {
  readonly name: string;
  readonly raw: unknown;
  readonly expect: Partial<DeathEntry>;
  readonly flags: readonly EntryFlag[];
}

const CASES: readonly Case[] = [
  {
    name: 'a number instead of a table',
    raw: 7,
    expect: { queue: null, count: null, routingKeys: [] },
    flags: ['not-a-table'],
  },
  { name: 'null', raw: null, expect: { queue: null }, flags: ['not-a-table'] },
  {
    name: 'an array instead of a table',
    raw: ['q'],
    expect: { queue: null },
    flags: ['not-a-table'],
  },
  {
    name: 'a missing queue',
    raw: { ...GOOD, queue: undefined },
    expect: { queue: null, reason: 'rejected' },
    flags: ['queue-missing'],
  },
  {
    name: 'a queue that is a number',
    raw: { ...GOOD, queue: 5 },
    expect: { queue: null },
    flags: ['queue-missing'],
  },
  {
    name: 'a missing reason',
    raw: { ...GOOD, reason: undefined },
    expect: { reason: null, reasonText: null },
    flags: ['reason-missing'],
  },
  {
    name: 'a reason a newer broker may record',
    raw: { ...GOOD, reason: 'at-most-once' },
    expect: { reason: null, reasonText: 'at-most-once' },
    flags: ['reason-unknown'],
  },
  {
    name: 'a count of zero',
    raw: { ...GOOD, count: 0 },
    expect: { count: null },
    flags: ['count-invalid', 'last-time-unavailable'],
  },
  {
    name: 'a negative count',
    raw: { ...GOOD, count: -3 },
    expect: { count: null },
    flags: ['count-invalid', 'last-time-unavailable'],
  },
  {
    name: 'a count that is a string',
    raw: { ...GOOD, count: '2' },
    expect: { count: null },
    flags: ['count-invalid', 'last-time-unavailable'],
  },
  {
    name: 'a count beyond the safe range',
    raw: { ...GOOD, count: 2n ** 70n },
    expect: { count: null },
    flags: ['count-invalid', 'last-time-unavailable'],
  },
  {
    name: 'a missing exchange',
    raw: { ...GOOD, exchange: undefined },
    expect: { exchange: null },
    flags: ['exchange-missing'],
  },
  {
    name: 'routing keys that are not an array',
    raw: { ...GOOD, 'routing-keys': 'k' },
    expect: { routingKeys: [] },
    flags: ['routing-keys-invalid'],
  },
  {
    name: 'a routing key that is a number',
    raw: { ...GOOD, 'routing-keys': ['a', 7, 'b'] },
    expect: { routingKeys: ['a', 'b'] },
    flags: ['routing-keys-invalid'],
  },
  {
    name: 'a time that is a string',
    raw: { ...GOOD, time: 'noon' },
    expect: { firstTimeMs: null, lastTimeMs: null },
    flags: ['time-invalid', 'last-time-unavailable'],
  },
  {
    name: 'a time in milliseconds where seconds are expected',
    raw: { ...GOOD, time: 1_700_000_000_000 },
    expect: { firstTimeMs: null },
    flags: ['time-invalid', 'last-time-unavailable'],
  },
  {
    name: 'a negative time',
    raw: { ...GOOD, time: -1 },
    expect: { firstTimeMs: null },
    flags: ['time-invalid', 'last-time-unavailable'],
  },
  {
    name: 'an original-expiration that is not digits',
    raw: { ...GOOD, 'original-expiration': '1e3' },
    expect: { originalTtlMs: null },
    flags: ['ttl-invalid'],
  },
  {
    name: 'an original-expiration of digits',
    raw: { ...GOOD, 'original-expiration': '60000' },
    expect: { originalTtlMs: 60000 },
    flags: [],
  },
  {
    name: 'an empty table',
    raw: {},
    expect: { queue: null, reason: null, count: null },
    flags: [
      'queue-missing',
      'reason-missing',
      'count-invalid',
      'exchange-missing',
      'routing-keys-invalid',
      'time-invalid',
      'last-time-unavailable',
    ],
  },
];

describe('readEntry: malformed records', () => {
  it.each(CASES)(
    'M1-04 AC-5 $name: the unusable field is null with a flag and nothing else changes',
    ({ raw, expect: expected, flags }) => {
      const entry = readEntry(newContext(), raw, 3, X_DEATH);
      expect(entry).toMatchObject({ index: 3, ...expected });
      expect([...entry.flags].sort()).toEqual([...flags].sort());
    },
  );

  it('M1-04 AC-5 reads a 1.0 record by its own names and units', () => {
    const entry = readEntry(
      newContext(),
      {
        queue: 'q',
        reason: 'delivery_limit',
        count: 4n,
        exchange: 'x',
        'routing-keys': ['k'],
        'first-time': 5000,
        'last-time': 9000,
        ttl: 250,
      },
      0,
      X_OPT_DEATHS,
    );
    expect(entry).toEqual({
      index: 0,
      queue: 'q',
      reason: 'delivery_limit',
      reasonText: null,
      count: 4,
      exchange: 'x',
      routingKeys: ['k'],
      firstTimeMs: 5000,
      lastTimeMs: 9000,
      originalTtlMs: 250,
      flags: [],
    });
  });

  it('M1-04 AC-5 never derives a missing field from another one', () => {
    // A 1.0 record without last-time stays without it, even for a count of 1.
    const entry = readEntry(
      newContext(),
      {
        queue: 'q',
        reason: 'expired',
        count: 1,
        exchange: '',
        'routing-keys': [],
        'first-time': 5000,
      },
      0,
      X_OPT_DEATHS,
    );
    expect(entry.lastTimeMs).toBeNull();
    expect(entry.flags).toEqual(['last-time-invalid']);
  });
});
