import { describe, expect, it } from 'vitest';
import { LIMITS } from './limits.ts';
import { normalizeDeaths } from './normalize.ts';
import { death, firstLast, x091, x10, type Death } from './testing/shapes.ts';
import type { DeathContext, DeathMessage } from './types.ts';

const HISTORY: readonly Death[] = [
  death({
    queue: 'orders.retry',
    reason: 'expired',
    exchange: 'orders.dlx',
    firstSec: 300,
  }),
  death({
    queue: 'orders.work',
    reason: 'rejected',
    exchange: 'orders',
    firstSec: 100,
  }),
];
const CTX: DeathContext = { clientDeathInterpreted: false };

const m091 = (
  extra: Record<string, unknown> = {},
  deaths = HISTORY,
): DeathMessage => ({
  protocol: 'amqp091',
  headers: { 'x-death': x091(deaths), ...firstLast(deaths), ...extra },
});

describe('first and last death', () => {
  it('M1-04 AC-3 reads x-first-death-* and x-last-death-* from 0-9-1 headers', () => {
    const result = normalizeDeaths(m091(), CTX);
    expect(result.first).toEqual({
      queue: 'orders.work',
      reason: 'rejected',
      exchange: 'orders',
    });
    expect(result.last).toEqual({
      queue: 'orders.retry',
      reason: 'expired',
      exchange: 'orders.dlx',
    });
    expect(result.provenance).toEqual([
      'x-death',
      'x-first-death-queue',
      'x-first-death-reason',
      'x-first-death-exchange',
      'x-last-death-queue',
      'x-last-death-reason',
      'x-last-death-exchange',
    ]);
    expect(result.flags).toEqual([]);
  });

  it('M1-04 AC-3 reads them from 1.0 message annotations, as a Map as well', () => {
    const annotations = { 'x-opt-deaths': x10(HISTORY), ...firstLast(HISTORY) };
    const plain = normalizeDeaths(
      { protocol: 'amqp10', messageAnnotations: annotations },
      CTX,
    );
    const map = normalizeDeaths(
      {
        protocol: 'amqp10',
        messageAnnotations: new Map(Object.entries(annotations)),
      },
      CTX,
    );
    expect(plain.first?.queue).toBe('orders.work');
    expect(plain.last?.queue).toBe('orders.retry');
    expect(map.first).toEqual(plain.first);
    expect(map.last).toEqual(plain.last);
    expect(plain.flags).toEqual([]);
  });

  it('M1-04 AC-3 keeps a header that is present but unusable as a null part', () => {
    const result = normalizeDeaths(m091({ 'x-first-death-exchange': 7 }), CTX);
    expect(result.first).toEqual({
      queue: 'orders.work',
      reason: 'rejected',
      exchange: null,
    });
  });

  it('M1-04 AC-3 reports a last death that is not the newest record', () => {
    for (const [header, value] of [
      ['x-last-death-queue', 'elsewhere'],
      ['x-last-death-reason', 'maxlen'],
    ] as const) {
      const result = normalizeDeaths(m091({ [header]: value }), CTX);
      expect(result.flags, header).toEqual(['last-death-mismatch']);
      expect(result.trust.state, header).toBe('inconsistent');
    }
  });

  it('M1-04 AC-3 reports a first death that no record explains', () => {
    const result = normalizeDeaths(
      m091({ 'x-first-death-queue': 'elsewhere' }),
      CTX,
    );
    expect(result.flags).toEqual(['first-death-mismatch']);
    expect(result.trust.state).toBe('inconsistent');
    // The queue of the first death with another reason is also unexplained.
    const reason = normalizeDeaths(
      m091({ 'x-first-death-reason': 'maxlen' }),
      CTX,
    );
    expect(reason.flags).toEqual(['first-death-mismatch']);
  });

  it('M1-04 AC-3 does not judge the first death from a history that was cut or unreadable', () => {
    const many = Array.from({ length: LIMITS.maxEntries + 5 }, (_, i) =>
      death({ queue: `q${String(i)}` }),
    );
    const cut = normalizeDeaths(
      m091({ 'x-first-death-queue': 'the.last.one' }, many),
      CTX,
    );
    expect(cut.flags).toEqual(['truncated']);
    const holes = x091(HISTORY);
    holes.push('not a table');
    const unreadable = normalizeDeaths(
      {
        protocol: 'amqp091',
        headers: {
          'x-death': holes,
          ...firstLast(HISTORY),
          'x-first-death-queue': 'elsewhere',
        },
      },
      CTX,
    );
    expect(unreadable.flags).not.toContain('first-death-mismatch');
  });

  it('M1-04 AC-3 compares a reason this library does not know as the text that was sent', () => {
    const odd = [death({ queue: 'q', reason: 'at-most-once' })];
    const result = normalizeDeaths(m091({}, odd), CTX);
    expect(result.entries[0]?.reasonText).toBe('at-most-once');
    expect(result.first?.reason).toBe('at-most-once');
    expect(result.flags).toEqual([]);
  });
});
