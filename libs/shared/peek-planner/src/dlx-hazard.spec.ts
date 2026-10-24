import type { Era } from '@app/domain-model';
import {
  SemanticsGapError,
  semanticsRegistry,
  type DeliveryLimit,
} from '@app/semantics';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  assessDlxHazard,
  provablyNonDlx,
  type DlxAssessment,
} from './dlx-hazard.ts';
import { readLimit } from './limit.ts';
import { classicQueue, preflightOf, queueOf } from './testing.ts';
import type {
  DlxEvidence,
  PeekPreflight,
  PlannerRegistry,
  PreflightQueue,
} from './types.ts';

const finite = (value: number): DeliveryLimit => ({ kind: 'finite', value });
const unlimited: DeliveryLimit = { kind: 'unlimited' };
const unknown: DeliveryLimit = { kind: 'unknown' };

interface Case {
  readonly era?: Era;
  readonly own?: DeliveryLimit;
  readonly sources?: readonly { queue: string; limit: DeliveryLimit }[];
  readonly complete?: boolean;
  readonly held?: readonly string[] | undefined;
  readonly queue?: PreflightQueue;
  readonly registry?: PlannerRegistry;
}

function assess(c: Case = {}): DlxAssessment {
  const own = c.own ?? finite(20);
  const queue =
    c.queue ??
    queueOf({
      deliveryLimit: own,
      limitState:
        own.kind === 'finite' || own.kind === 'unknown' ? 'finite' : 'minus1',
    });
  const dlxSources: DlxEvidence = {
    sources: c.sources ?? [],
    complete: c.complete ?? true,
    unknownReasons: c.complete === false ? [{ code: 'truncated' }] : [],
  };
  const preflight: PeekPreflight = preflightOf(queue, {
    dlxSources,
    heldDeathSources: 'held' in c ? c.held : [],
  });
  return assessDlxHazard({
    registry: c.registry ?? semanticsRegistry,
    era: c.era ?? '4.3',
    limit: readLimit(queue),
    preflight,
  });
}

describe('R7 W-OVERLIMIT: a finite limit not above every source limit + 1 is blocked', () => {
  it('blocks Lt <= Ls + 1 and offers the lowest safe limit, Ls + 2', () => {
    for (const lt of [1, 20, 21]) {
      const result = assess({
        own: finite(lt),
        sources: [{ queue: 'orders', limit: finite(20) }],
      });
      expect(result.verdict, `Lt ${String(lt)}`).toEqual({
        kind: 'blocked',
        reasons: ['dlx-sources-over-limit'],
        sources: ['orders'],
        minimumFinite: 22,
      });
    }
    for (const lt of [22, 23, 100]) {
      expect(
        assess({
          own: finite(lt),
          sources: [{ queue: 'orders', limit: finite(20) }],
        }).verdict,
        `Lt ${String(lt)}`,
      ).toEqual({ kind: 'safe' });
    }
  });

  it('takes the highest source, and names only the sources that are too high', () => {
    const result = assess({
      own: finite(25),
      sources: [
        { queue: 'low', limit: finite(5) },
        { queue: 'high', limit: finite(30) },
        { queue: 'edge', limit: finite(24) },
      ],
    });
    expect(result.verdict).toEqual({
      kind: 'blocked',
      reasons: ['dlx-sources-over-limit'],
      sources: ['edge', 'high'],
      minimumFinite: 32,
    });
  });

  it('treats a source with no limit as unbounded: only -1 is safe', () => {
    expect(
      assess({ own: finite(1000), sources: [{ queue: 'u', limit: unlimited }] })
        .verdict,
    ).toEqual({
      kind: 'blocked',
      reasons: ['dlx-source-unbounded'],
      sources: ['u'],
      minimumFinite: null,
    });
    expect(
      assess({ own: unlimited, sources: [{ queue: 'u', limit: unlimited }] })
        .verdict,
    ).toEqual({ kind: 'not-applicable' });
  });

  it('is not a hazard where the era does not carry the count, or for a queue without a finite limit', () => {
    const sources = [{ queue: 'orders', limit: finite(20) }];
    for (const era of ['3.13', '4.0-4.2'] as const) {
      expect(assess({ era, own: finite(20), sources }).verdict, era).toEqual({
        kind: 'not-applicable',
      });
    }
    expect(assess({ own: unlimited, sources }).verdict).toEqual({
      kind: 'not-applicable',
    });
    expect(assess({ queue: classicQueue(), sources }).verdict).toEqual({
      kind: 'not-applicable',
    });
  });

  it('checks 4.4 like 4.3 although the registry has no 4.4 cells, and reports the assumption', () => {
    const result = assess({
      era: '4.4',
      own: finite(20),
      sources: [{ queue: 'orders', limit: finite(20) }],
    });
    expect(result.verdict.kind).toBe('blocked');
    expect(result.gap).not.toBeNull();
    expect(assess({ era: '4.3', own: finite(20), sources: [] }).gap).toBeNull();
  });
});

describe('AC-8 incomplete evidence is finite-unknown, an empty complete list is no hazard', () => {
  it('reads an empty list as no hazard only when it is complete', () => {
    expect(assess({ sources: [], complete: true }).verdict).toEqual({
      kind: 'safe',
    });
    expect(assess({ sources: [], complete: false }).verdict).toEqual({
      kind: 'unknown',
      why: ['evidence-incomplete'],
    });
  });

  it('does not take complete on trust when unknown reasons are listed', () => {
    const queue = queueOf();
    const preflight = preflightOf(queue, {
      dlxSources: {
        sources: [],
        complete: true,
        unknownReasons: [{ code: 'policy-unreadable' }],
      },
    });
    const result = assessDlxHazard({
      registry: semanticsRegistry,
      era: '4.3',
      limit: readLimit(queue),
      preflight,
    });
    expect(result.verdict).toEqual({
      kind: 'unknown',
      why: ['evidence-incomplete'],
    });
  });

  it('is unknown when a source limit is unknown or the own limit is', () => {
    expect(
      assess({ sources: [{ queue: 'q', limit: unknown }] }).verdict,
    ).toEqual({ kind: 'unknown', why: ['source-limit-unknown'] });
    expect(assess({ own: unknown }).verdict).toEqual({
      kind: 'unknown',
      why: ['own-limit-unknown'],
    });
    expect(
      assess({ sources: [{ queue: 'q', limit: unknown }], complete: false })
        .verdict,
    ).toEqual({
      kind: 'unknown',
      why: ['evidence-incomplete', 'source-limit-unknown'],
    });
  });

  it('lets a definite hazard win over a doubt', () => {
    expect(
      assess({
        own: finite(20),
        complete: false,
        sources: [
          { queue: 'a', limit: finite(20) },
          { queue: 'b', limit: unknown },
        ],
      }).verdict.kind,
    ).toBe('blocked');
  });
});

describe('AC-9 an x-death queue is a DLX source', () => {
  it('adds a queue named by the x-death that is not among the sources, with an unknown limit', () => {
    const result = assess({ sources: [], held: ['gone'] });
    expect(result.verdict).toEqual({
      kind: 'unknown',
      why: ['held-death-source-unknown'],
    });
    expect(result.heldDeath).toBe('covered');
  });

  it('does not double count a queue the evidence already has, and uses its limit', () => {
    const sources = [{ queue: 'orders', limit: finite(20) }];
    expect(
      assess({ own: finite(22), sources, held: ['orders'] }).verdict,
    ).toEqual({
      kind: 'safe',
    });
    expect(
      assess({ own: finite(21), sources, held: ['orders'] }).verdict.kind,
    ).toBe('blocked');
  });

  it('says "not checked" when the x-death was not looked at, and leaves the verdict alone', () => {
    const result = assess({ sources: [], held: undefined });
    expect(result.heldDeath).toBe('not-checked');
    expect(result.verdict).toEqual({ kind: 'safe' });
  });

  it('proves "not a DLX target" only with complete evidence, no source and a checked x-death', () => {
    const base = (over: Partial<PeekPreflight>): PeekPreflight => ({
      ...preflightOf(queueOf()),
      ...over,
    });
    const complete: DlxEvidence = {
      sources: [],
      complete: true,
      unknownReasons: [],
    };
    expect(
      provablyNonDlx(base({ dlxSources: complete, heldDeathSources: [] })),
    ).toBe(true);
    expect(
      provablyNonDlx(
        base({ dlxSources: complete, heldDeathSources: undefined }),
      ),
    ).toBe(false);
    expect(
      provablyNonDlx(base({ dlxSources: complete, heldDeathSources: ['x'] })),
    ).toBe(false);
    expect(
      provablyNonDlx(
        base({
          dlxSources: { ...complete, complete: false },
          heldDeathSources: [],
        }),
      ),
    ).toBe(false);
    expect(
      provablyNonDlx(
        base({
          dlxSources: {
            ...complete,
            sources: [{ queue: 'a', limit: unlimited }],
          },
          heldDeathSources: [],
        }),
      ),
    ).toBe(false);
  });
});

describe('the boundary and the carry-over come from the registry (I-3)', () => {
  it('derives the margin from the failed-delivery cell: with no extra delivery Ls + 1 is safe', () => {
    const noExtra: PlannerRegistry = {
      ...semanticsRegistry,
      cell: (key) => {
        const cell = semanticsRegistry.cell(key);
        return key.action === 'close_while_holding' && cell.effect !== null
          ? { ...cell, effect: { ...cell.effect, deltaDC: 0 } }
          : cell;
      },
    };
    const sources = [{ queue: 'orders', limit: finite(20) }];
    expect(
      assess({ own: finite(21), sources, registry: noExtra }).verdict,
    ).toEqual({
      kind: 'safe',
    });
    expect(
      assess({ own: finite(20), sources, registry: noExtra }).verdict,
    ).toMatchObject({
      kind: 'blocked',
      minimumFinite: 21,
    });
  });

  it('is not a hazard in an era whose registry rule is inclusive', () => {
    const inclusive: PlannerRegistry = {
      ...semanticsRegistry,
      isDoomed: (_era, counters) => (counters.deliveryCount ?? 0) >= 20,
    };
    expect(
      assess({
        own: finite(20),
        sources: [{ queue: 'orders', limit: finite(20) }],
        registry: inclusive,
      }).verdict,
    ).toEqual({ kind: 'not-applicable' });
  });
});

describe('properties of the verdict', () => {
  const limitArb = fc.oneof(
    fc.integer({ min: 1, max: 60 }).map(finite),
    fc.constant(unlimited),
    fc.constant(unknown),
  );
  const sourcesArb = fc.array(
    fc.record({
      queue: fc.constantFrom('a', 'b', 'c', 'd', 'e'),
      limit: limitArb,
    }),
    { maxLength: 5 },
  );

  it('agrees with an independent oracle for the strict rule', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 80 }),
        sourcesArb,
        fc.boolean(),
        (lt, sources, complete) => {
          const unique = [
            ...new Map(sources.map((s) => [s.queue, s])).values(),
          ];
          const { verdict } = assess({
            own: finite(lt),
            sources: unique,
            complete,
          });
          // The oracle: arrival Ls + 1, one failed delivery more, dropped when above Lt.
          const blocked = unique.some(
            (s) =>
              s.limit.kind === 'unlimited' ||
              (s.limit.kind === 'finite' && s.limit.value + 2 > lt),
          );
          if (blocked) return verdict.kind === 'blocked';
          const doubt =
            !complete || unique.some((s) => s.limit.kind === 'unknown');
          return verdict.kind === (doubt ? 'unknown' : 'safe');
        },
      ),
    );
  });

  it('is monotone: a lower limit never unblocks, and the offered minimum is safe and minimal', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 80 }),
        sourcesArb,
        (lt, sources) => {
          const unique = [
            ...new Map(sources.map((s) => [s.queue, s])).values(),
          ];
          const at = assess({ own: finite(lt), sources: unique }).verdict;
          if (at.kind !== 'blocked') return true;
          if (
            lt > 1 &&
            assess({ own: finite(lt - 1), sources: unique }).verdict.kind !==
              'blocked'
          ) {
            return false;
          }
          if (at.minimumFinite === null) return true;
          const safe = assess({
            own: finite(at.minimumFinite),
            sources: unique,
          }).verdict.kind;
          const below = assess({
            own: finite(at.minimumFinite - 1),
            sources: unique,
          }).verdict.kind;
          return safe !== 'blocked' && below === 'blocked';
        },
      ),
    );
  });
});

describe('a missing failed-delivery row is assumed to add one (R7)', () => {
  it('keeps Lt = Ls + 1 blocked when the close_while_holding row cannot be read', () => {
    const noRow: PlannerRegistry = {
      ...semanticsRegistry,
      cell: (key) => {
        if (key.action === 'close_while_holding')
          throw new SemanticsGapError(key);
        return semanticsRegistry.cell(key);
      },
    };
    const sources = [{ queue: 'orders', limit: finite(20) }];
    const result = assess({ own: finite(21), sources, registry: noRow });
    expect(result.verdict).toMatchObject({
      kind: 'blocked',
      minimumFinite: 22,
    });
    expect(result.gap).not.toBeNull();
  });
});
