import { semanticsRegistry } from '@app/semantics';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { computeCaps, type CapsInput } from './caps.ts';

const input = (extra: Partial<CapsInput> = {}): CapsInput => ({
  registry: semanticsRegistry,
  era: '4.0-4.2',
  queueType: 'quorum',
  admin: false,
  verification: 'verified',
  requested: 20,
  holdCount: 1000,
  ...extra,
});

describe('AC-6 caps come from the registry and every clamp is reported (R4)', () => {
  it('quorum 4.0-4.2: 50 for a user, 200 for an administrator', () => {
    expect(computeCaps(input({ requested: 200 }))).toMatchObject({
      ok: true,
      count: 50,
      limitedBy: 'cap',
    });
    expect(computeCaps(input({ requested: 200, admin: true }))).toMatchObject({
      ok: true,
      count: 200,
      limitedBy: 'cap',
    });
    expect(computeCaps(input({ requested: 100, admin: true }))).toMatchObject({
      ok: true,
      count: 100,
      limitedBy: 'request',
    });
  });

  it('takes the numbers of the registry for the other queue types and eras', () => {
    for (const era of ['3.13', '4.0-4.2', '4.3', '4.4'] as const) {
      for (const queueType of ['classic', 'quorum'] as const) {
        for (const admin of [false, true]) {
          const row = semanticsRegistry.peekCaps(
            era,
            queueType,
            admin ? 'admin' : 'user',
            'verified',
          );
          expect(
            computeCaps(input({ era, queueType, admin, requested: 100_000 })),
            `${era} ${queueType} ${String(admin)}`,
          ).toMatchObject({ ok: true, count: row.max, bytes: row.maxBytes });
        }
      }
    }
  });

  it('is capped by the registry for a build that is not verified', () => {
    const verified = computeCaps(input({ era: '4.3', requested: 500 }));
    const unverified = computeCaps(
      input({ era: '4.3', requested: 500, verification: 'unknown-build' }),
    );
    expect(verified).toMatchObject({ ok: true, count: 500 });
    expect(unverified).toMatchObject({ ok: true, count: 20 });
  });

  it('reports the binding bound in the order cap, hold, bytes, request', () => {
    expect(computeCaps(input({ requested: 40, holdCount: 40 }))).toMatchObject({
      count: 40,
      limitedBy: 'hold',
    });
    expect(
      computeCaps(
        input({
          requested: 40,
          holdCount: 40,
          avgBytes: (16 * 1024 * 1024) / 40,
        }),
      ),
    ).toMatchObject({ count: 40, limitedBy: 'hold' });
    expect(
      computeCaps(
        input({ requested: 40, holdCount: 100, avgBytes: 1_048_576 }),
      ),
    ).toMatchObject({
      count: 16,
      limitedBy: 'bytes',
    });
    expect(computeCaps(input({ requested: 5 }))).toMatchObject({
      count: 5,
      limitedBy: 'request',
    });
    expect(computeCaps(input({ requested: 100 }))).toMatchObject({
      requested: 100,
      count: 50,
      limitedBy: 'cap',
    });
  });

  it('caps the bytes at the registry value and at the request', () => {
    expect(computeCaps(input({ maxBytes: 1_000_000_000 }))).toMatchObject({
      bytes: 16 * 1024 * 1024,
    });
    expect(
      computeCaps(
        input({ maxBytes: 1_000_000, avgBytes: 100_000, requested: 50 }),
      ),
    ).toMatchObject({ bytes: 1_000_000, count: 10, limitedBy: 'bytes' });
  });

  it('refuses when one average message does not fit the bytes', () => {
    expect(computeCaps(input({ maxBytes: 1_000, avgBytes: 1_001 }))).toEqual({
      ok: false,
      reason: 'avg-message-exceeds-bytes',
    });
    expect(
      computeCaps(input({ maxBytes: 1_000, avgBytes: 1_000 })),
    ).toMatchObject({
      ok: true,
      count: 1,
    });
    // An unknown or nonsensical size is not a reason to refuse.
    expect(computeCaps(input({ avgBytes: 0 }))).toMatchObject({ ok: true });
  });

  it('reports a registry gap instead of inventing caps', () => {
    const outcome = computeCaps(input({ queueType: 'stream' }));
    expect(outcome).toMatchObject({ ok: false, reason: 'semantics-gap' });
  });

  it('never returns more than any bound (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 1, max: 5_000 }),
        fc.option(fc.integer({ min: 1, max: 20_000_000 }), { nil: undefined }),
        fc.option(fc.integer({ min: 1, max: 2_000_000 }), { nil: undefined }),
        fc.boolean(),
        (requested, holdCount, maxBytes, avgBytes, admin) => {
          const outcome = computeCaps(
            input({ requested, holdCount, maxBytes, avgBytes, admin }),
          );
          if (!outcome.ok) return true;
          const row = semanticsRegistry.peekCaps(
            '4.0-4.2',
            'quorum',
            admin ? 'admin' : 'user',
            'verified',
          );
          expect(outcome.count).toBeGreaterThanOrEqual(1);
          expect(outcome.count).toBeLessThanOrEqual(
            Math.min(requested, row.max, holdCount),
          );
          expect(outcome.bytes).toBeLessThanOrEqual(row.maxBytes);
          if (avgBytes !== undefined) {
            expect(outcome.count * avgBytes).toBeLessThanOrEqual(outcome.bytes);
          }
          return true;
        },
      ),
    );
  });
});
