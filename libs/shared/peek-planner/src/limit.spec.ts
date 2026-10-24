import { ERAS, type Era } from '@app/domain-model';
import { semanticsRegistry } from '@app/semantics';
import { describe, expect, it } from 'vitest';

import {
  carriesDeliveryCount,
  doomedOperator,
  estimateLimit,
  readLimit,
  resolveCell,
  visibleLimits,
  type CellRequest,
} from './limit.ts';
import { classicQueue, preflightOf, queueOf } from './testing.ts';

const nack = (
  era: Era,
  limitState: CellRequest['limitState'],
  extra: Partial<CellRequest> = {},
): CellRequest => ({
  era,
  queueType: 'quorum',
  protocol: 'amqp091',
  action: 'amqp091.nack_requeue',
  limitState,
  ...extra,
});

describe('readLimit (R3)', () => {
  it('has no limit for a classic queue and reads no cell for it', () => {
    expect(readLimit(classicQueue())).toEqual({
      basis: 'unlimited',
      state: 'unset',
      reasons: [],
    });
  });

  it('reads a coherent finite limit', () => {
    expect(readLimit(queueOf())).toEqual({
      basis: 'finite',
      value: 20,
      state: 'finite',
      reasons: [],
    });
  });

  it('keeps the two kinds of unlimited apart: unset and -1 differ on 3.13', () => {
    for (const state of ['unset', 'minus1'] as const) {
      const view = readLimit(
        queueOf({ deliveryLimit: { kind: 'unlimited' }, limitState: state }),
      );
      expect(view).toEqual({ basis: 'unlimited', state, reasons: [] });
    }
  });

  it('reads an unknown limit as finite-unknown, with the finite row as stand-in', () => {
    expect(readLimit(queueOf({ deliveryLimit: { kind: 'unknown' } }))).toEqual({
      basis: 'finite-unknown',
      state: 'finite',
      reasons: ['own-limit-unknown'],
    });
  });

  it('reads an incoherent pair as unknown, never as unlimited', () => {
    const cases = [
      queueOf({
        deliveryLimit: { kind: 'finite', value: 20 },
        limitState: 'unset',
      }),
      queueOf({
        deliveryLimit: { kind: 'finite', value: 20 },
        limitState: 'minus1',
      }),
      queueOf({ deliveryLimit: { kind: 'unlimited' }, limitState: 'finite' }),
      queueOf({ deliveryLimit: { kind: 'finite', value: 0 } }),
      queueOf({ deliveryLimit: { kind: 'finite', value: -1 } }),
      queueOf({ deliveryLimit: { kind: 'finite', value: 2.5 } }),
      queueOf({ deliveryLimit: { kind: 'finite', value: Number.NaN } }),
    ];
    for (const queue of cases) {
      expect(readLimit(queue), JSON.stringify(queue.deliveryLimit)).toEqual({
        basis: 'finite-unknown',
        state: 'finite',
        reasons: ['limit-incoherent'],
      });
    }
  });
});

describe('the doom rule, probed from the registry (R6)', () => {
  it('reads the operator of each era from isDoomed', () => {
    expect(doomedOperator(semanticsRegistry, '3.13')).toBe('>=');
    expect(doomedOperator(semanticsRegistry, '4.0-4.2')).toBe('>=');
    expect(doomedOperator(semanticsRegistry, '4.3')).toBe('>');
    expect(doomedOperator(semanticsRegistry, '4.4')).toBe('>');
  });

  it('follows the registry, not the era: an inverted isDoomed flips the answer', () => {
    const inverted = {
      ...semanticsRegistry,
      isDoomed: (...args: Parameters<typeof semanticsRegistry.isDoomed>) =>
        !semanticsRegistry.isDoomed(...args),
    };
    expect(doomedOperator(inverted, '4.3')).toBe('>=');
    expect(doomedOperator(inverted, '3.13')).toBe('>');
  });

  it('AC-17 every era has a carry-over decision', () => {
    // A new Era in @app/domain-model fails here until someone decides it (OQ-1422).
    const decided: Record<Era, boolean> = {
      '3.13': false,
      '4.0-4.2': false,
      '4.3': true,
      '4.4': true,
    };
    expect(Object.keys(decided).sort()).toEqual([...ERAS].sort());
    for (const era of ERAS) {
      expect(carriesDeliveryCount(semanticsRegistry, era), era).toBe(
        decided[era],
      );
    }
  });

  it('carries only where the count is the limit counter and the comparison is strict', () => {
    const limit = (dc: number): boolean => dc > 20;
    const strict = {
      ...semanticsRegistry,
      isDoomed: (_era: Era, c: { deliveryCount?: number | undefined }) =>
        limit(c.deliveryCount ?? 0),
    };
    const inclusive = {
      ...semanticsRegistry,
      isDoomed: (_era: Era, c: { deliveryCount?: number | undefined }) =>
        (c.deliveryCount ?? 0) >= 20,
    };
    expect(carriesDeliveryCount(strict, '3.13')).toBe(true);
    expect(carriesDeliveryCount(inclusive, '4.3')).toBe(false);
  });
});

describe('resolveCell (R3, R12)', () => {
  it('answers the first choice without a gap', () => {
    const found = resolveCell(semanticsRegistry, nack('4.0-4.2', 'finite'));
    expect(found?.cell.id).toBe(
      'SEM-4.0-4.2-quorum-amqp091-amqp091.nack_requeue-limit-finite',
    );
    expect(found?.gap).toBeNull();
    expect(found?.delayedRetryUnread).toBe(false);
  });

  it('reads the limit state: 3.13 unset is the tail, minus1 is destructive', () => {
    const unset = resolveCell(semanticsRegistry, nack('3.13', 'unset'));
    expect(unset?.cell.effect?.position).toBe('tail');
    const minus1 = resolveCell(semanticsRegistry, nack('3.13', 'minus1'));
    expect(minus1?.cell.effect?.destructive).toBe(true);
    expect(minus1?.gap).toBeNull();
  });

  it('uses the delayed-retry type the preflight read, and none for an era without that key', () => {
    const delayed = resolveCell(
      semanticsRegistry,
      nack('4.3', 'finite', { delayedRetry: 'all' }),
    );
    expect(delayed?.cell.effect?.position).toBe('delayed');
    expect(delayed?.gap).toBeNull();
    const failed = resolveCell(
      semanticsRegistry,
      nack('4.3', 'finite', { delayedRetry: 'failed' }),
    );
    expect(failed?.cell.effect?.position).toBe('head');
    // 3.13 cells have no delayed-retry key: the type is ignored, and that is not a gap.
    const older = resolveCell(
      semanticsRegistry,
      nack('3.13', 'finite', { delayedRetry: 'all' }),
    );
    expect(older?.gap).toBeNull();
    expect(older?.cell.id).toBe(
      'SEM-3.13-quorum-amqp091-amqp091.nack_requeue-limit-finite',
    );
  });

  it('assumes disabled when the type was not read, and says so', () => {
    const found = resolveCell(semanticsRegistry, nack('4.3', 'finite'));
    expect(found?.cell.id).toContain('delayed-disabled');
    expect(found?.delayedRetryUnread).toBe(true);
    expect(found?.gap).toBeNull();
    // A cell that does not depend on delayed retry does not make the assumption.
    const timeout = resolveCell(semanticsRegistry, {
      ...nack('4.3', 'finite', { delayedRetry: 'all' }),
      action: 'consumer_timeout',
      delayedRetryMatters: false,
    });
    expect(timeout?.cell.id).toContain('consumer_timeout');
    expect(timeout?.delayedRetryUnread).toBe(false);
    expect(timeout?.gap).toBeNull();
  });

  it('substitutes the finite row of the same era, and reports the key that was asked for', () => {
    const found = resolveCell(semanticsRegistry, nack('4.0-4.2', 'unset'));
    expect(found?.cell.id).toBe(
      'SEM-4.0-4.2-quorum-amqp091-amqp091.nack_requeue-limit-finite',
    );
    expect(found?.gap).toBe(
      '4.0-4.2|quorum|amqp091|amqp091.nack_requeue|unset|-',
    );
  });

  it('falls back to the conservative era when the era has no cells at all (4.4)', () => {
    const found = resolveCell(semanticsRegistry, nack('4.4', 'minus1'));
    expect(found?.cell.id).toBe(
      'SEM-4.0-4.2-quorum-amqp091-amqp091.nack_requeue-limit-minus1',
    );
    expect(found?.gap).toBe('4.4|quorum|amqp091|amqp091.nack_requeue|minus1|-');
  });

  it('answers null when no row exists anywhere (a classic queue has no cells)', () => {
    expect(
      resolveCell(semanticsRegistry, {
        ...nack('4.3', 'unset'),
        queueType: 'classic',
      }),
    ).toBeNull();
  });

  it('lets an error that is not a gap through', () => {
    const broken = {
      ...semanticsRegistry,
      cell: () => {
        throw new TypeError('boom');
      },
    };
    expect(() => resolveCell(broken, nack('4.3', 'finite'))).toThrow(TypeError);
  });
});

describe('the limit estimate of A-2', () => {
  it('is the lowest finite limit seen, at most 20', () => {
    expect(estimateLimit([])).toBe(20);
    expect(estimateLimit([50, 30])).toBe(20);
    expect(estimateLimit([50, 7, 12])).toBe(7);
    expect(estimateLimit([0, -1, 2.5, Number.NaN, 9])).toBe(9);
  });

  it('collects every finite limit the preflight shows', () => {
    const preflight = preflightOf(
      queueOf({
        visibleLimits: [25],
        limitDisagreement: {
          stat: { kind: 'unlimited' },
          computed: { kind: 'finite', value: 20 },
        },
      }),
      {
        dlxSources: {
          sources: [
            { queue: 'a', limit: { kind: 'finite', value: 5 } },
            { queue: 'b', limit: { kind: 'unlimited' } },
            { queue: 'c', limit: { kind: 'unknown' } },
          ],
          complete: true,
          unknownReasons: [],
        },
      },
    );
    expect(visibleLimits(preflight).sort((a, b) => a - b)).toEqual([5, 20, 25]);
  });
});
