import { describe, expect, it } from 'vitest';
import { normalizeDeaths } from './normalize.ts';
import { death, firstLast, x091, x10, type Death } from './testing/shapes.ts';
import type { DeathContext, DeathMessage } from './types.ts';

const HISTORY: readonly Death[] = [
  death({ queue: 'orders.retry', reason: 'expired', firstSec: 1_700_000_300 }),
  death({ queue: 'orders.work', reason: 'rejected', firstSec: 1_700_000_100 }),
];

const OPAQUE: DeathContext = { clientDeathInterpreted: false }; // 4.0 and later
const INTERPRETED: DeathContext = { clientDeathInterpreted: true }; // 3.13
const UNKNOWN: DeathContext = { clientDeathInterpreted: null };

const broker = (
  extra: Record<string, unknown> = {},
  deaths: readonly Death[] = HISTORY,
  clientPublished = false,
): DeathMessage => ({
  protocol: 'amqp091',
  headers: { 'x-death': x091(deaths), ...firstLast(deaths), ...extra },
  ...(clientPublished ? { clientPublished } : {}),
});

describe('trust in a client-published x-death', () => {
  it('M1-04 AC-2 marks a client-set x-death untrusted on 4.x and interpreted on 3.13', () => {
    const message = broker({}, HISTORY, true);
    const on4 = normalizeDeaths(message, OPAQUE);
    expect(on4.trusted).toBe(false);
    expect(on4.trust).toEqual({
      trusted: false,
      state: 'client-supplied',
      reasons: ['client-published-hint'],
    });
    const on313 = normalizeDeaths(message, INTERPRETED);
    expect(on313.trusted).toBe(true);
    expect(on313.trust).toEqual({
      trusted: true,
      state: 'interpreted',
      reasons: ['broker-interprets-client-value', 'client-published-hint'],
    });
    // The records themselves are the same either way: only the verdict differs.
    expect(on313.entries).toEqual(on4.entries);
  });

  it('M1-04 AC-2 takes a replay stamp of this product as evidence of a client copy on 4.x', () => {
    for (const stamp of [
      'x-redrive-count',
      'x-redriven-from',
      'x-redriven-at',
    ]) {
      const result = normalizeDeaths(broker({ [stamp]: 'q' }), OPAQUE);
      expect(result.trust.state, stamp).toBe('client-supplied');
      expect(result.trust.reasons, stamp).toEqual(['replay-stamp']);
      expect(result.flags, stamp).toContain('replay-stamp-present');
      expect(result.provenance, stamp).toContain(stamp);
    }
  });

  it('M1-04 AC-2 takes the headers of a republishing framework as evidence of a client copy on 4.x', () => {
    for (const marker of [
      'x-original-exchange',
      'x-original-routingKey',
      'x-exception-message',
      'x-exception-stacktrace',
    ]) {
      const result = normalizeDeaths(broker({ [marker]: 'v' }), OPAQUE);
      expect(result.trust.state, marker).toBe('client-supplied');
      expect(result.trust.reasons, marker).toEqual(['republish-marker']);
      expect(result.flags, marker).toContain('republish-marker-present');
    }
  });

  it('M1-04 AC-2 takes an x-death without x-first-death-* as evidence of a client copy on 4.x', () => {
    const result = normalizeDeaths(
      { protocol: 'amqp091', headers: { 'x-death': x091(HISTORY) } },
      OPAQUE,
    );
    expect(result.trust).toEqual({
      trusted: false,
      state: 'client-supplied',
      reasons: ['first-death-header-missing'],
    });
    expect(result.flags).toEqual(
      expect.arrayContaining([
        'first-death-header-missing',
        'last-death-header-missing',
      ]),
    );
  });

  it('M1-04 AC-2 trusts a consistent record with no sign of a copy on 4.x, and says nothing proves it', () => {
    const result = normalizeDeaths(broker(), OPAQUE);
    expect(result.trust).toEqual({
      trusted: true,
      state: 'broker-shaped',
      reasons: ['provenance-unproven'],
    });
  });

  it('M1-04 AC-2 fails closed when the context is unknown, and still lists the evidence', () => {
    const result = normalizeDeaths(broker({ 'x-redrive-count': 1 }), UNKNOWN);
    expect(result.trusted).toBe(false);
    expect(result.trust).toEqual({
      trusted: false,
      state: 'unknown-broker',
      reasons: ['broker-behaviour-unknown', 'replay-stamp'],
    });
  });

  it('M1-04 AC-2 calls a history whose first/last headers disagree inconsistent on every broker', () => {
    const message = broker({ 'x-last-death-queue': 'somewhere.else' });
    for (const context of [OPAQUE, INTERPRETED]) {
      const result = normalizeDeaths(message, context);
      expect(result.trust.state).toBe('inconsistent');
      expect(result.trusted).toBe(false);
      expect(result.trust.reasons).toContain('first-last-mismatch');
    }
  });

  it('M1-04 AC-2 judges nothing when there is no history', () => {
    const result = normalizeDeaths(
      { protocol: 'amqp091', headers: {} },
      OPAQUE,
    );
    expect(result.trust).toEqual({
      trusted: false,
      state: 'no-history',
      reasons: [],
    });
  });

  it('M1-04 AC-2 finds the stamps of a 1.0 message in its application properties', () => {
    const result = normalizeDeaths(
      {
        protocol: 'amqp10',
        messageAnnotations: {
          'x-opt-deaths': x10(HISTORY),
          ...firstLast(HISTORY),
        },
        applicationProperties: { 'x-redriven-at': 1_700_000_999 },
      },
      OPAQUE,
    );
    expect(result.trust.state).toBe('client-supplied');
    expect(result.trust.reasons).toEqual(['replay-stamp']);
  });

  it('M1-04 AC-2 reads only the names of the markers, never their values', () => {
    const headers: Record<string, unknown> = {
      'x-death': x091(HISTORY),
      ...firstLast(HISTORY),
    };
    Object.defineProperty(headers, 'x-original-exchange', {
      enumerable: true,
      get(): string {
        throw new Error('value read');
      },
    });
    const result = normalizeDeaths({ protocol: 'amqp091', headers }, OPAQUE);
    // The unreadable header is counted and read as absent: it is neither evidence nor output.
    expect(result.flags).toContain('read-error');
    expect(result.trust.state).toBe('broker-shaped');
    expect(JSON.stringify(result)).not.toContain('value read');
  });
});
