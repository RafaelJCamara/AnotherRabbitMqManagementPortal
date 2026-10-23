import { describe, expect, it } from 'vitest';
import { normalizeDeaths } from './normalize.ts';
import { death, firstLast, x091, x10, type Death } from './testing/shapes.ts';
import type { DeathContext, DeathMessage } from './types.ts';

const CTX: DeathContext = { clientDeathInterpreted: false };

const HISTORY: readonly Death[] = [
  death({ queue: 'a', count: 3, firstSec: 300, lastSec: 900 }),
  death({ queue: 'b', count: 2, firstSec: 200 }),
  death({ queue: 'c', count: 1, firstSec: 100 }),
];

const m091 = (
  extra: Record<string, unknown> = {},
  deaths = HISTORY,
): DeathMessage => ({
  protocol: 'amqp091',
  headers: { 'x-death': x091(deaths), ...firstLast(deaths), ...extra },
});

describe('totals and counters', () => {
  it('M1-04 AC-4 sums the counts exactly, for both protocols', () => {
    expect(normalizeDeaths(m091(), CTX).totalDeaths).toBe(6);
    const m10: DeathMessage = {
      protocol: 'amqp10',
      messageAnnotations: {
        'x-opt-deaths': x10(HISTORY),
        ...firstLast(HISTORY),
      },
    };
    expect(normalizeDeaths(m10, CTX).totalDeaths).toBe(6);
  });

  it('M1-04 AC-4 gives no total when a count is unknown, when entries were cut, or when there are none', () => {
    const unknown = x091(HISTORY);
    (unknown[1] as Record<string, unknown>).count = 'two';
    expect(
      normalizeDeaths(
        { protocol: 'amqp091', headers: { 'x-death': unknown } },
        CTX,
      ).totalDeaths,
    ).toBeNull();
    const many = Array.from({ length: 200 }, () => death());
    expect(normalizeDeaths(m091({}, many), CTX).totalDeaths).toBeNull();
    expect(
      normalizeDeaths({ protocol: 'amqp091', headers: {} }, CTX).totalDeaths,
    ).toBeNull();
  });

  it('M1-04 AC-4 gives no total, and says why, when the sum leaves the safe range', () => {
    const huge = [
      death({ queue: 'a', count: Number.MAX_SAFE_INTEGER }),
      death({ queue: 'b', count: 5 }),
    ];
    const result = normalizeDeaths(m091({}, huge), CTX);
    expect(result.totalDeaths).toBeNull();
    expect(result.flags).toContain('total-overflow');
  });

  it('M1-04 AC-4 reads the counters with the header they came from', () => {
    const result = normalizeDeaths(
      m091({ 'x-delivery-count': { t: 'long', v: 4 }, 'x-acquired-count': 9 }),
      CTX,
    );
    expect(result.counters).toEqual({
      deliveryCount: { value: 4, source: 'x-delivery-count' },
      acquiredCount: { value: 9, source: 'x-acquired-count' },
    });
    expect(result.provenance).toEqual(
      expect.arrayContaining(['x-delivery-count', 'x-acquired-count']),
    );
  });

  it('M1-04 AC-4 reads a 1.0 delivery count from the annotation first, then from the header section', () => {
    const base = { 'x-opt-deaths': x10(HISTORY), ...firstLast(HISTORY) };
    const fromHeader = normalizeDeaths(
      {
        protocol: 'amqp10',
        messageAnnotations: base,
        header: { 'delivery-count': 2 },
      },
      CTX,
    );
    expect(fromHeader.counters.deliveryCount).toEqual({
      value: 2,
      source: 'header.delivery-count',
    });
    const both = normalizeDeaths(
      {
        protocol: 'amqp10',
        messageAnnotations: { ...base, 'x-delivery-count': 7 },
        header: { 'delivery-count': 2 },
      },
      CTX,
    );
    expect(both.counters.deliveryCount).toEqual({
      value: 7,
      source: 'x-delivery-count',
    });
  });

  it('M1-04 AC-4 leaves an invalid counter null and flagged, and an absent one null', () => {
    for (const bad of [-1, 1.5, 'three', null, {}]) {
      const result = normalizeDeaths(m091({ 'x-delivery-count': bad }), CTX);
      expect(result.counters.deliveryCount).toBeNull();
      expect(result.flags).toContain('counter-invalid');
    }
    const none = normalizeDeaths(m091(), CTX);
    expect(none.counters).toEqual({ deliveryCount: null, acquiredCount: null });
    expect(none.flags).toEqual([]);
  });
});

describe('missing, stripped and absent histories', () => {
  it('M1-04 AC-8 reports first/last headers without x-death as client-stripped and invents no history', () => {
    const result = normalizeDeaths(
      { protocol: 'amqp091', headers: { ...firstLast(HISTORY) } },
      CTX,
    );
    expect(result.state).toBe('present');
    expect(result.entries).toEqual([]);
    expect(result.totalDeaths).toBeNull();
    expect(result.flags).toEqual(['client-stripped']);
    expect(result.first?.queue).toBe('c');
    expect(result.trust.state).toBe('no-history');
  });

  it('M1-04 AC-8 says none for a message that was never dead-lettered', () => {
    const result = normalizeDeaths(
      { protocol: 'amqp091', headers: { 'x-delivery-count': 1, other: 'v' } },
      CTX,
    );
    expect(result).toMatchObject({
      state: 'none',
      entries: [],
      first: null,
      last: null,
      flags: [],
    });
    expect(result.trusted).toBe(false);
  });

  it('M1-04 AC-8 reports records without first/last headers', () => {
    const result = normalizeDeaths(
      { protocol: 'amqp091', headers: { 'x-death': x091(HISTORY) } },
      CTX,
    );
    expect(result.flags).toEqual([
      'first-death-header-missing',
      'last-death-header-missing',
    ]);
    expect(result.first).toBeNull();
    expect(result.last).toBeNull();
  });

  it('M1-04 AC-8 refuses a message with no protocol without throwing', () => {
    const result = normalizeDeaths({} as unknown as DeathMessage, CTX);
    expect(result).toMatchObject({
      state: 'unreadable',
      entries: [],
      trusted: false,
    });
    expect(result.flags).toContain('read-error');
  });
});

describe('what reaches the output', () => {
  it('M1-04 AC-12 contains only values of the death, first/last, counter and marker headers', () => {
    const message: DeathMessage = {
      protocol: 'amqp091',
      headers: {
        'x-death': x091([death({ queue: 'orders.work' })]),
        ...firstLast([death({ queue: 'orders.work' })]),
        'x-delivery-count': 2,
        authorization: 'Bearer SECRET-TOKEN',
        'x-exception-message': 'password=hunter2',
        'x-exception-stacktrace': 'at secret.Frame()',
        'content-hash': 'SECRET-HASH',
      },
      body: new TextEncoder().encode('SECRET-BODY'),
    } as DeathMessage;
    const json = JSON.stringify(normalizeDeaths(message, CTX));
    for (const secret of [
      'SECRET-TOKEN',
      'hunter2',
      'secret.Frame',
      'SECRET-HASH',
      'SECRET-BODY',
    ]) {
      expect(json, secret).not.toContain(secret);
    }
    expect(json).toContain('orders.work');
    // The names of the markers are provenance; their values are not read.
    expect(json).toContain('x-exception-message');
  });
});
