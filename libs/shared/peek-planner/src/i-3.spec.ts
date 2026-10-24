import type { Era } from '@app/domain-model';
import { semanticsRegistry } from '@app/semantics';
import { describe, expect, it } from 'vitest';

import { planPeek } from './plan.ts';
import { isRejection } from './rejections.ts';
import { factsOf, preflightOf, queueOf, requestOf } from './testing.ts';
import type { PeekFacts, PlannerRegistry, PreflightQueue } from './types.ts';

const warningIds = (
  era: Era,
  queue: PreflightQueue,
  registry: PlannerRegistry,
  extra: Partial<PeekFacts> = {},
  sources: { queue: string; limit: { kind: 'finite'; value: number } }[] = [],
): string[] => {
  const result = planPeek(
    requestOf(),
    factsOf(
      era,
      preflightOf(queue, {
        dlxSources: { sources, complete: true, unknownReasons: [] },
      }),
      { registry, ...extra },
    ),
  );
  return isRejection(result)
    ? [`rejected:${result.code}`]
    : result.warnings.map((w) => w.id);
};

/** A registry that answers the cells of one era with the cells of another. */
function swapped(
  from: Era,
  to: Era,
  keyedByDelayedRetry: boolean,
): PlannerRegistry {
  return {
    ...semanticsRegistry,
    cell: (key) =>
      semanticsRegistry.cell(
        key.era === from
          ? {
              ...key,
              era: to,
              ...(keyedByDelayedRetry
                ? { delayedRetry: 'disabled' as const }
                : {}),
            }
          : key,
      ),
  };
}

const finiteQueue = (): PreflightQueue => queueOf();
const minus1Queue = (): PreflightQueue =>
  queueOf({ deliveryLimit: { kind: 'unlimited' }, limitState: 'minus1' });

describe('AC-16 decisions follow the registry, not the era name', () => {
  it('AC-16 follows the settle cells: 3.13 with the cells of 4.3 has no W-313 and no destroyed -1', () => {
    expect(warningIds('3.13', finiteQueue(), semanticsRegistry)).toContain(
      'W-313',
    );
    expect(
      warningIds('3.13', finiteQueue(), swapped('3.13', '4.3', true)),
    ).not.toContain('W-313');
    expect(warningIds('3.13', minus1Queue(), semanticsRegistry)).toEqual([
      'rejected:LIMIT_MINUS1_313',
    ]);
    expect(
      warningIds('3.13', minus1Queue(), swapped('3.13', '4.3', true)),
    ).not.toContain('rejected:LIMIT_MINUS1_313');
  });

  it('AC-16 follows the settle cells the other way: 4.3 with the cells of 4.0-4.2 asks for the budget consent', () => {
    const queue = queueOf({ delayedRetry: { type: 'disabled' } });
    expect(warningIds('4.3', queue, semanticsRegistry)).not.toContain(
      'W-BUDGET',
    );
    expect(
      warningIds('4.3', queue, swapped('4.3', '4.0-4.2', false)),
    ).toContain('W-BUDGET');
  });

  it('AC-16 follows the doom rule: inverting isDoomed flips the operator and the carry-over', () => {
    const inverted: PlannerRegistry = {
      ...semanticsRegistry,
      isDoomed: (...args) => !semanticsRegistry.isDoomed(...args),
    };
    const sources = [
      { queue: 'a', limit: { kind: 'finite' as const, value: 20 } },
    ];
    const queue = queueOf({ delayedRetry: { type: 'disabled' } });
    expect(warningIds('4.3', queue, semanticsRegistry, {}, sources)).toEqual([
      'rejected:OVERLIMIT_DLQ',
    ]);
    expect(warningIds('4.3', queue, inverted, {}, sources)).not.toContain(
      'rejected:OVERLIMIT_DLQ',
    );
    // and an era that did not carry the count now does, when the registry's rule says so
    const strictEverywhere: PlannerRegistry = {
      ...semanticsRegistry,
      isDoomed: (_era, counters, limit) =>
        semanticsRegistry.isDoomed('4.3', counters, limit),
    };
    expect(
      warningIds('3.13', queue, semanticsRegistry, {}, sources),
    ).not.toContain('rejected:OVERLIMIT_DLQ');
    expect(warningIds('3.13', queue, strictEverywhere, {}, sources)).toEqual([
      'rejected:OVERLIMIT_DLQ',
    ]);
    const plan = planPeek(
      requestOf(),
      factsOf('4.3', preflightOf(queue), { registry: inverted }),
    );
    if (isRejection(plan)) throw new Error(plan.code);
    expect(plan.preview.guard.doomedWhen).toBe('>=');
  });

  it('AC-16 takes the caps and the severities from the registry', () => {
    const odd: PlannerRegistry = {
      ...semanticsRegistry,
      peekCaps: () => ({ def: 3, max: 7, maxBytes: 7_000 }),
      warning: (id) => ({
        ...semanticsRegistry.warning(id),
        severity:
          id === 'W-HOLD' ? 'consent' : semanticsRegistry.warning(id).severity,
      }),
    };
    const plan = planPeek(
      requestOf({ count: 20 }),
      factsOf(
        '4.3',
        preflightOf(queueOf({ delayedRetry: { type: 'disabled' } })),
        {
          registry: odd,
        },
      ),
    );
    if (isRejection(plan)) throw new Error(plan.code);
    expect(plan.preview.caps).toMatchObject({
      count: 7,
      bytes: 7_000,
      limitedBy: 'cap',
    });
    expect(plan.consentsRequired).toContain('W-HOLD');
  });

  it('AC-16 never reads the broker version of the profile', () => {
    const base = factsOf('4.0-4.2', preflightOf(queueOf()));
    const odd: PeekFacts = {
      ...base,
      profile: {
        ...base.profile,
        versions: {
          min: { major: 99, minor: 0, patch: 0, raw: '99.0.0' },
          perNode: { n1: { major: 1, minor: 2, patch: 3, raw: '1.2.3' } },
          mixed: false,
          build: 'commercial-or-unknown',
        },
      },
    };
    expect(planPeek(requestOf(), odd)).toEqual(planPeek(requestOf(), base));
  });
});
