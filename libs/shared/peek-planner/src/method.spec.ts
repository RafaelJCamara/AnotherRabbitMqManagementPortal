import type { Era } from '@app/domain-model';
import {
  SemanticsGapError,
  semanticsRegistry,
  type CellKey,
  type DeliveryLimit,
  type SettleEffect,
} from '@app/semantics';
import { describe, expect, it } from 'vitest';

import { CONSERVATIVE_ERA } from './limit.ts';
import { addsNoFailedDelivery } from './method.ts';
import { planPeek } from './plan.ts';
import { isRejection, type PeekRejection } from './rejections.ts';
import {
  classicQueue,
  factsOf,
  mcpClient,
  preflightOf,
  profileOf,
  queueOf,
  requestOf,
} from './testing.ts';
import type {
  DlxEvidence,
  PeekPlanDraft,
  PeekRequest,
  PeekPrincipal,
  PlannerRegistry,
  PreflightQueue,
} from './types.ts';

const finite = (value: number): DeliveryLimit => ({ kind: 'finite', value });
const provable: DlxEvidence = {
  sources: [],
  complete: true,
  unknownReasons: [],
};

interface Setup {
  readonly queue: PreflightQueue;
  readonly dlx?: DlxEvidence;
  readonly held?: readonly string[] | undefined;
  readonly prefer?: PeekRequest['prefer'];
  readonly principal?: PeekPrincipal;
}

function plan(era: Era, setup: Setup): PeekPlanDraft | PeekRejection {
  return planPeek(
    requestOf({ prefer: setup.prefer, count: 100 }),
    factsOf(
      era,
      preflightOf(setup.queue, {
        dlxSources: setup.dlx ?? provable,
        heldDeathSources: 'held' in setup ? setup.held : [],
      }),
      {
        profile: profileOf(era),
        ...(setup.principal ? { principal: setup.principal } : {}),
      },
    ),
  );
}

/** What the HTTP fallback answers: its method, or the reasons it was refused. */
function http(era: Era, setup: Setup): string {
  const result = plan(era, { ...setup, prefer: 'http-fallback' });
  if (!isRejection(result)) return result.preview.method;
  return `${result.code}:${result.reasons.join(',')}`;
}

const unlimited = (
  limitState: 'unset' | 'minus1',
  extra: Partial<PreflightQueue> = {},
): PreflightQueue =>
  queueOf({
    deliveryLimit: { kind: 'unlimited' },
    limitState,
    delayedRetry: { type: 'disabled' },
    ...extra,
  });

const unknownLimit = (extra: Partial<PreflightQueue> = {}): PreflightQueue =>
  queueOf({
    deliveryLimit: { kind: 'unknown' },
    delayedRetry: { type: 'disabled' },
    ...extra,
  });

const finiteQueue = (
  value = 20,
  extra: Partial<PreflightQueue> = {},
): PreflightQueue =>
  queueOf({
    deliveryLimit: finite(value),
    delayedRetry: { type: 'disabled' },
    ...extra,
  });

describe('AC-10 3.13: the HTTP fallback is never offered for a quorum queue', () => {
  it('AC-10 refuses a finite and an unknown limit and an unlimited queue, and allows a classic queue', () => {
    expect(http('3.13', { queue: finiteQueue() })).toBe(
      'METHOD_UNAVAILABLE:http-limit-finite',
    );
    expect(http('3.13', { queue: unknownLimit() })).toBe(
      'METHOD_UNAVAILABLE:http-limit-unknown',
    );
    // unset means unlimited on 3.13; it is still not in the allowed list of A-3
    expect(http('3.13', { queue: unlimited('unset') })).toBe(
      'METHOD_UNAVAILABLE:http-era-not-strict',
    );
    expect(http('3.13', { queue: classicQueue() })).toBe('http.get_fallback');
  });

  it('AC-10 still plans the same queues over AMQP', () => {
    for (const queue of [finiteQueue(), unknownLimit(), unlimited('unset')]) {
      const result = plan('3.13', { queue });
      expect(isRejection(result) ? result.code : result.preview.method).toBe(
        'amqp091.get',
      );
    }
  });
});

describe('AC-11 4.0-4.2: the HTTP fallback is never offered for a quorum queue', () => {
  it('AC-11 refuses a finite and an unknown limit and an unlimited queue, and allows a classic queue', () => {
    expect(http('4.0-4.2', { queue: finiteQueue() })).toBe(
      'METHOD_UNAVAILABLE:http-limit-finite',
    );
    expect(http('4.0-4.2', { queue: unknownLimit() })).toBe(
      'METHOD_UNAVAILABLE:http-limit-unknown',
    );
    expect(http('4.0-4.2', { queue: unlimited('minus1') })).toBe(
      'METHOD_UNAVAILABLE:http-era-not-strict',
    );
    expect(http('4.0-4.2', { queue: classicQueue() })).toBe(
      'http.get_fallback',
    );
  });
});

describe('AC-12 4.3: the HTTP fallback only for classic and provably non-DLX unlimited queues', () => {
  const minus1 = (): PreflightQueue => unlimited('minus1');

  it('AC-12 allows a classic queue, and caps the count at 50', () => {
    const result = plan('4.3', {
      queue: classicQueue(),
      prefer: 'http-fallback',
    });
    if (isRejection(result)) throw new Error(result.code);
    expect(result.preview.method).toBe('http.get_fallback');
    expect(result.preview.caps).toMatchObject({
      requested: 100,
      count: 50,
      limitedBy: 'cap',
    });
  });

  it('AC-12 allows an unlimited quorum queue only with complete evidence, no source and a checked x-death', () => {
    const ok = plan('4.3', { queue: minus1(), prefer: 'http-fallback' });
    if (isRejection(ok)) throw new Error(ok.code);
    expect(ok.preview.method).toBe('http.get_fallback');
    expect(ok.preview.caps.count).toBe(50);
    expect(ok.preview.disposition).toEqual({
      kind: 'none',
      reason: 'unlimited',
    });
    expect(ok.preview.evidence).toEqual({
      dlx: 'not-applicable',
      heldDeath: 'covered',
    });

    // a source, even one that is harmless to a queue without a limit
    expect(
      http('4.3', {
        queue: minus1(),
        dlx: { ...provable, sources: [{ queue: 'orders', limit: finite(20) }] },
      }),
    ).toBe('METHOD_UNAVAILABLE:http-not-provably-non-dlx');
    // evidence that says it is incomplete
    expect(
      http('4.3', { queue: minus1(), dlx: { ...provable, complete: false } }),
    ).toBe('METHOD_UNAVAILABLE:http-not-provably-non-dlx');
    // an x-death that nobody looked at
    expect(http('4.3', { queue: minus1(), held: undefined })).toBe(
      'METHOD_UNAVAILABLE:http-held-death-unchecked',
    );
    // a queue that held messages from a source the evidence does not know
    expect(http('4.3', { queue: minus1(), held: ['gone'] })).toBe(
      'METHOD_UNAVAILABLE:http-not-provably-non-dlx',
    );
  });

  it('AC-12 refuses a finite limit even when the dead-letter check passes, and an unknown one', () => {
    expect(http('4.3', { queue: finiteQueue(50) })).toBe(
      'METHOD_UNAVAILABLE:http-limit-finite',
    );
    expect(http('4.3', { queue: unknownLimit() })).toBe(
      'METHOD_UNAVAILABLE:http-limit-unknown',
    );
    // evidence that makes a finite limit unknown reads as unknown, not as finite
    expect(
      http('4.3', {
        queue: finiteQueue(50),
        dlx: { ...provable, complete: false },
      }),
    ).toBe('METHOD_UNAVAILABLE:http-limit-unknown');
  });

  it('AC-12 stops a queue that fails the dead-letter check before the method is considered', () => {
    const result = plan('4.3', {
      queue: finiteQueue(20),
      dlx: { ...provable, sources: [{ queue: 'orders', limit: finite(20) }] },
      prefer: 'http-fallback',
    });
    expect(isRejection(result) ? result.code : 'plan').toBe('OVERLIMIT_DLQ');
  });

  it('AC-12 reports every reason at once', () => {
    expect(
      http('3.13', {
        queue: unlimited('unset'),
        dlx: { ...provable, complete: false },
        held: undefined,
      }),
    ).toBe('METHOD_UNAVAILABLE:http-era-not-strict,http-held-death-unchecked');
  });

  it('AC-12 never offers it for a single active consumer queue', () => {
    expect(
      http('4.3', {
        queue: unlimited('minus1', { singleActiveConsumer: true }),
      }),
    ).toBe('METHOD_UNAVAILABLE:sac-consumer-path-unavailable');
  });
});

describe('AC-13 4.4: no cells, so the conservative substitute and no unattended plan', () => {
  it('AC-13 plans for a person with a consent, a list of the missing rows and 4.3 hazard rules', () => {
    const result = plan('4.4', { queue: finiteQueue(20) });
    if (isRejection(result)) throw new Error(result.code);
    expect(result.warnings.map((w) => w.id)).toContain('W-SEMANTICS-GAP');
    expect(result.consentsRequired).toContain('W-SEMANTICS-GAP');
    expect(result.preview.gaps.length).toBeGreaterThan(0);
    expect(result.preview.expected[0]?.cell).toBe(
      'SEM-4.0-4.2-quorum-amqp091-amqp091.nack_requeue-limit-finite',
    );
    // the doom rule of the registry for 4.4 is the strict one: the carry-over is checked
    expect(result.preview.guard.doomedWhen).toBe('>');
    const blocked = plan('4.4', {
      queue: finiteQueue(20),
      dlx: { ...provable, sources: [{ queue: 'orders', limit: finite(20) }] },
    });
    expect(isRejection(blocked) ? blocked.code : 'plan').toBe('OVERLIMIT_DLQ');
  });

  it('AC-13 refuses an AI run, and never offers the fallback for a finite limit', () => {
    for (const principal of [mcpClient]) {
      expect(plan('4.4', { queue: finiteQueue(20), principal })).toMatchObject({
        rejected: true,
        code: 'SEMANTICS_GAP',
      });
    }
    expect(http('4.4', { queue: finiteQueue(20) })).toBe(
      'METHOD_UNAVAILABLE:http-limit-finite',
    );
    // a classic queue needs no row, so it is planned, and without a gap
    const classic = plan('4.4', {
      queue: classicQueue(),
      principal: mcpClient,
    });
    if (isRejection(classic)) throw new Error(classic.code);
    expect(classic.preview.gaps).toEqual([]);
  });
});

describe('the other methods follow the registry cells', () => {
  it('uses a consumer for a single-active-consumer quorum queue only where the timeout adds no failed delivery', () => {
    const sac = (): PreflightQueue =>
      finiteQueue(20, { singleActiveConsumer: true });
    const ok = plan('4.3', { queue: sac() });
    if (isRejection(ok)) throw new Error(ok.code);
    expect(ok.preview.method).toBe('amqp091.consumer-sac');
    expect(ok.warnings.map((w) => w.id)).toContain('W-SAC-QQ');
    for (const era of ['3.13', '4.0-4.2'] as const) {
      expect(
        plan(era, { queue: queueOf({ singleActiveConsumer: true }) }),
      ).toMatchObject({
        rejected: true,
        code: 'METHOD_UNAVAILABLE',
        reasons: ['sac-consumer-path-unavailable'],
      });
    }
  });

  it('offers the AMQP 1.0 step only where the release adds no failed delivery and the guard counter is visible', () => {
    const ok = plan('4.3', { queue: finiteQueue(), prefer: 'amqp10-step' });
    if (isRejection(ok)) throw new Error(ok.code);
    expect(ok.preview.method).toBe('amqp10.credit1-step');
    for (const era of ['3.13', '4.0-4.2'] as const) {
      expect(
        plan(era, { queue: queueOf(), prefer: 'amqp10-step' }),
      ).toMatchObject({
        rejected: true,
        code: 'METHOD_UNAVAILABLE',
        reasons: ['amqp10-not-available'],
      });
    }
    for (const queue of [
      classicQueue(),
      finiteQueue(20, { singleActiveConsumer: true }),
    ]) {
      expect(plan('4.3', { queue, prefer: 'amqp10-step' })).toMatchObject({
        rejected: true,
        reasons: ['amqp10-not-available'],
      });
    }
  });

  it('keeps get for a classic queue with single active consumer, and warns', () => {
    const result = plan('4.3', {
      queue: classicQueue({ singleActiveConsumer: true }),
    });
    if (isRejection(result)) throw new Error(result.code);
    expect(result.preview.method).toBe('amqp091.get');
    expect(result.warnings.map((w) => w.id)).toContain('W-SAC-CQ');
  });
});

describe('what a read path may rely on', () => {
  const effect = (change: Partial<SettleEffect> = {}): SettleEffect => ({
    deltaAC: 1,
    deltaDC: 0,
    countsTowardLimit: 'if-dc-gt-limit',
    position: 'head',
    destructive: false,
    ...change,
  });

  it('is a return that adds no failed delivery, is not counted and does not destroy the message', () => {
    expect(addsNoFailedDelivery(effect())).toBe(true);
    expect(addsNoFailedDelivery(effect({ countsTowardLimit: 'no' }))).toBe(
      true,
    );
    expect(addsNoFailedDelivery(null)).toBe(false);
    expect(addsNoFailedDelivery(effect({ deltaDC: 1 }))).toBe(false);
    expect(addsNoFailedDelivery(effect({ countsTowardLimit: 'yes' }))).toBe(
      false,
    );
    expect(addsNoFailedDelivery(effect({ destructive: true }))).toBe(false);
  });

  it('offers the AMQP 1.0 step on an unlimited 4.0-4.2 queue only if the guard counter is visible: it is not', () => {
    // the release does not count there (minus1), but a 1.0 client cannot see the acquired count
    expect(
      plan('4.0-4.2', { queue: unlimited('minus1'), prefer: 'amqp10-step' }),
    ).toMatchObject({ rejected: true, reasons: ['amqp10-not-available'] });
  });

  /** A registry that answers one action with the given effect for every era and limit state. */
  const answering = (
    action: string,
    answer: SettleEffect,
    only?: (key: CellKey) => boolean,
  ): PlannerRegistry => ({
    ...semanticsRegistry,
    cell: (key) => {
      const real = semanticsRegistry.cell(key);
      return key.action === action && (only?.(key) ?? true)
        ? { ...real, effect: answer }
        : real;
    },
  });

  it('asks the registry for the release: a counted release is not offered even where the rule is strict', () => {
    const counted = answering(
      'amqp10.released',
      effect({ countsTowardLimit: 'yes' }),
    );
    const result = planPeek(
      requestOf({ prefer: 'amqp10-step' }),
      factsOf('4.3', preflightOf(finiteQueue()), { registry: counted }),
    );
    expect(result).toMatchObject({
      rejected: true,
      reasons: ['amqp10-not-available'],
    });
    const failed = answering('amqp10.released', effect({ deltaDC: 1 }));
    expect(
      planPeek(
        requestOf({ prefer: 'amqp10-step' }),
        factsOf('4.3', preflightOf(finiteQueue()), { registry: failed }),
      ),
    ).toMatchObject({ rejected: true });
  });

  it('does not take the consumer path on a row that stands in for a missing one', () => {
    // The 4.3 timeout row is missing; the conservative era's row is made to look harmless.
    const substitute: PlannerRegistry = {
      ...semanticsRegistry,
      cell: (key) => {
        if (key.action !== 'consumer_timeout')
          return semanticsRegistry.cell(key);
        if (key.era !== CONSERVATIVE_ERA) throw new SemanticsGapError(key);
        return { ...semanticsRegistry.cell(key), effect: effect() };
      },
    };
    const result = planPeek(
      requestOf(),
      factsOf(
        '4.3',
        preflightOf(finiteQueue(20, { singleActiveConsumer: true })),
        {
          registry: substitute,
        },
      ),
    );
    expect(result).toMatchObject({
      rejected: true,
      code: 'METHOD_UNAVAILABLE',
      reasons: ['sac-consumer-path-unavailable'],
    });
  });
});
