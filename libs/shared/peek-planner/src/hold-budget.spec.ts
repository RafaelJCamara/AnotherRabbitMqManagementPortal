import { semanticsRegistry } from '@app/semantics';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CHANNEL_MARGIN_MS,
  DEFAULT_CONSUMER_TIMEOUT_MS,
  HARD_CAP_MS,
  holdBudget,
  TARGET_CAP_MS,
  timeoutStyle,
} from './hold-budget.ts';
import { resolveCell } from './limit.ts';

const ok = (input: Parameters<typeof holdBudget>[0]) => {
  const outcome = holdBudget(input);
  if (!outcome.ok) throw new Error(`expected a budget, got ${outcome.reason}`);
  return outcome;
};

describe('the timeout formula comes from the consumer_timeout cell (R5)', () => {
  const timeoutCell = (
    era: '3.13' | '4.0-4.2' | '4.3',
    limit: 'unset' | 'finite',
  ) =>
    resolveCell(semanticsRegistry, {
      era,
      queueType: 'quorum',
      protocol: 'amqp091',
      action: 'consumer_timeout',
      limitState: limit,
      delayedRetryMatters: false,
    })?.cell ?? null;

  it('is the channel-level close where the timeout is a failed delivery, the queue-level one where it is not', () => {
    expect(timeoutStyle(timeoutCell('3.13', 'finite'))).toBe('channel');
    expect(timeoutStyle(timeoutCell('3.13', 'unset'))).toBe('channel');
    expect(timeoutStyle(timeoutCell('4.0-4.2', 'finite'))).toBe('channel');
    expect(timeoutStyle(timeoutCell('4.3', 'finite'))).toBe('queue');
  });

  it('applies both formulas when there is no cell', () => {
    expect(timeoutStyle(null)).toBe('both');
  });
});

describe('R5 the hold budget', () => {
  it('takes the 30 s cap when nothing else is lower', () => {
    const budget = ok({ style: 'channel', rttMs: 5 });
    expect(budget.hardAbortMs).toBe(HARD_CAP_MS);
    expect(budget.targetMs).toBe(TARGET_CAP_MS);
    expect(budget.derivedFrom).toEqual(['hard-cap']);
    expect(budget.maxCount).toBe(1000);
  });

  it('is min(30 s, ttl / 4, channel timeout - 90 s) for a channel-level timeout', () => {
    const budget = ok({ ttlMs: 60_000, style: 'channel', rttMs: 5 });
    expect(budget.hardAbortMs).toBe(15_000);
    expect(budget.derivedFrom).toEqual(['message-ttl']);
    // 1,800,000 - 90,000 = 1,710,000: not the binding bound.
    const small = ok({
      consumerTimeoutMs: 100_000,
      style: 'channel',
      rttMs: 5,
    });
    expect(small.hardAbortMs).toBe(10_000);
    expect(small.derivedFrom).toEqual(['channel-timeout']);
  });

  it('is min(30 s, ttl / 4, timeout / 4) for a queue-level timeout', () => {
    expect(
      ok({ consumerTimeoutMs: 60_000, style: 'queue', rttMs: 5 }).hardAbortMs,
    ).toBe(15_000);
    expect(
      ok({ consumerTimeoutMs: 60_000, style: 'queue', rttMs: 5 }).derivedFrom,
    ).toEqual(['consumer-timeout']);
    // The channel-level margin does not apply to a queue-level timeout.
    expect(
      ok({ consumerTimeoutMs: 100_000, style: 'queue', rttMs: 5 }).hardAbortMs,
    ).toBe(25_000);
  });

  it('applies both formulas when the style is unknown, and lists every equal bound', () => {
    const both = ok({ consumerTimeoutMs: 120_000, style: 'both', rttMs: 5 });
    // 120,000 / 4 = 30,000 and 120,000 - 90,000 = 30,000 and the cap is 30,000.
    expect(both.hardAbortMs).toBe(30_000);
    expect(both.derivedFrom).toEqual([
      'hard-cap',
      'consumer-timeout',
      'channel-timeout',
    ]);
    const lower = ok({ consumerTimeoutMs: 100_000, style: 'both', rttMs: 5 });
    expect(lower.hardAbortMs).toBe(10_000);
  });

  it('uses the broker default timeout when the preflight did not read one', () => {
    expect(DEFAULT_CONSUMER_TIMEOUT_MS).toBe(1_800_000);
    expect(CHANNEL_MARGIN_MS).toBe(90_000);
    expect(ok({ style: 'both', rttMs: 5 }).hardAbortMs).toBe(30_000);
  });

  it('targets min(5 s, hard abort) and counts floor(target / rtt) messages', () => {
    const budget = ok({ ttlMs: 8_000, style: 'channel', rttMs: 300 });
    expect(budget.hardAbortMs).toBe(2_000);
    expect(budget.targetMs).toBe(2_000);
    expect(budget.maxCount).toBe(6);
  });

  it('fails closed', () => {
    expect(holdBudget({ ttlMs: 0, style: 'channel', rttMs: 5 })).toEqual({
      ok: false,
      reason: 'hold-hard-abort-too-small',
    });
    expect(holdBudget({ ttlMs: 3, style: 'channel', rttMs: 5 })).toEqual({
      ok: false,
      reason: 'hold-hard-abort-too-small',
    });
    expect(
      holdBudget({ consumerTimeoutMs: 90_000, style: 'channel', rttMs: 5 }),
    ).toEqual({ ok: false, reason: 'hold-hard-abort-too-small' });
    expect(holdBudget({ ttlMs: Number.NaN, style: 'queue', rttMs: 5 })).toEqual(
      {
        ok: false,
        reason: 'hold-hard-abort-too-small',
      },
    );
    for (const rttMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(holdBudget({ style: 'both', rttMs })).toEqual({
        ok: false,
        reason: 'rtt-invalid',
      });
    }
    expect(holdBudget({ style: 'both', rttMs: 5_001 })).toEqual({
      ok: false,
      reason: 'rtt-exceeds-target',
    });
    expect(holdBudget({ style: 'both', rttMs: 5_000 })).toMatchObject({
      ok: true,
      maxCount: 1,
    });
  });

  it('never exceeds any bound it was given (property)', () => {
    fc.assert(
      fc.property(
        fc.option(fc.integer({ min: 1, max: 10_000_000 }), { nil: undefined }),
        fc.option(fc.integer({ min: 1, max: 10_000_000 }), { nil: undefined }),
        fc.constantFrom('queue', 'channel', 'both' as const),
        fc.integer({ min: 1, max: 6_000 }),
        (ttlMs, consumerTimeoutMs, style, rttMs) => {
          const outcome = holdBudget({
            ttlMs,
            consumerTimeoutMs,
            style,
            rttMs,
          });
          if (!outcome.ok) return true;
          const timeout = consumerTimeoutMs ?? DEFAULT_CONSUMER_TIMEOUT_MS;
          expect(outcome.hardAbortMs).toBeLessThanOrEqual(HARD_CAP_MS);
          if (ttlMs !== undefined) {
            expect(outcome.hardAbortMs).toBeLessThanOrEqual(
              Math.floor(ttlMs / 4),
            );
          }
          if (style !== 'channel') {
            expect(outcome.hardAbortMs).toBeLessThanOrEqual(
              Math.floor(timeout / 4),
            );
          }
          if (style !== 'queue') {
            expect(outcome.hardAbortMs).toBeLessThanOrEqual(
              timeout - CHANNEL_MARGIN_MS,
            );
          }
          expect(outcome.targetMs).toBe(
            Math.min(TARGET_CAP_MS, outcome.hardAbortMs),
          );
          expect(outcome.maxCount * rttMs).toBeLessThanOrEqual(
            outcome.targetMs,
          );
          expect((outcome.maxCount + 1) * rttMs).toBeGreaterThan(
            outcome.targetMs,
          );
          return outcome.derivedFrom.length > 0;
        },
      ),
    );
  });
});
