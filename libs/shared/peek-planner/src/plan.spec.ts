import { FeatureIdSchema } from '@app/contracts';
import type { Era } from '@app/domain-model';
import type { DeliveryLimit } from '@app/semantics';
import { describe, expect, it } from 'vitest';

import { planPeek } from './plan.ts';
import { isRejection, type PeekRejection } from './rejections.ts';
import {
  classicQueue,
  factsOf,
  human,
  mcpClient,
  preflightOf,
  profileOf,
  queueOf,
  requestOf,
  rescueOf,
  unattended,
  type ProfileOptions,
} from './testing.ts';
import type {
  PeekPlanDraft,
  PeekPreflight,
  PeekPrincipal,
  PeekProfile,
  PeekRequest,
  PreflightQueue,
} from './types.ts';

const finite = (value: number): DeliveryLimit => ({ kind: 'finite', value });

interface Setup {
  readonly queue?: PreflightQueue;
  readonly preflight?: Partial<Omit<PeekPreflight, 'queue'>>;
  readonly request?: Partial<PeekRequest>;
  readonly principal?: PeekPrincipal;
  readonly profile?: PeekProfile;
  readonly profileOptions?: ProfileOptions;
}

function plan(era: Era, setup: Setup = {}): PeekPlanDraft | PeekRejection {
  return planPeek(
    requestOf(setup.request),
    factsOf(era, preflightOf(setup.queue ?? queueOf(), setup.preflight), {
      principal: setup.principal ?? human,
      profile: setup.profile ?? profileOf(era, setup.profileOptions),
    }),
  );
}

function draft(result: PeekPlanDraft | PeekRejection): PeekPlanDraft {
  if (isRejection(result)) {
    throw new Error(
      `expected a plan, got ${result.code} ${result.reasons.join(',')}`,
    );
  }
  return result;
}

function rejection(result: PeekPlanDraft | PeekRejection): PeekRejection {
  if (!isRejection(result)) throw new Error('expected a rejection');
  return result;
}

const ids = (list: readonly { id: string }[]): string[] =>
  list.map((w) => w.id);

/** A 4.3 queue whose delayed retry was read, so W-DELAY is not asked for by assumption. */
const queue43 = (extra: Partial<PreflightQueue> = {}): PreflightQueue =>
  queueOf({ delayedRetry: { type: 'disabled' }, ...extra });

describe('AC-1 a 4.3 queue whose limit is not above its sources L+1 is blocked', () => {
  const sources = [{ queue: 'orders', limit: finite(20) }];
  const evidence = { sources, complete: true, unknownReasons: [] };

  it('AC-1 blocks with W-OVERLIMIT and offers the delivery-limit -1 fix', () => {
    const blocked = rejection(
      plan('4.3', {
        queue: queue43(),
        preflight: { dlxSources: evidence },
      }),
    );
    expect(blocked).toMatchObject({
      rejected: true,
      code: 'OVERLIMIT_DLQ',
      reasons: ['dlx-sources-over-limit'],
      fix: {
        kind: 'delivery-limit-policy',
        queue: 'orders.dlq',
        limit: -1,
        minimumFinite: 22,
      },
    });
    expect(ids(blocked.warnings)).toEqual(['W-OVERLIMIT']);
    expect(blocked.warnings[0]?.severity).toBe('block');
  });

  it('AC-1 plans the same queue once its limit is above the sources L+1, or unlimited', () => {
    for (const limit of [22, 23, 50]) {
      const ok = draft(
        plan('4.3', {
          queue: queue43({ deliveryLimit: finite(limit) }),
          preflight: { dlxSources: evidence },
        }),
      );
      expect(ids(ok.warnings), String(limit)).not.toContain('W-OVERLIMIT');
      expect(ok.preview.evidence.dlx).toBe('safe');
    }
    const unlimited = draft(
      plan('4.3', {
        queue: queue43({
          deliveryLimit: { kind: 'unlimited' },
          limitState: 'minus1',
        }),
        preflight: { dlxSources: evidence },
      }),
    );
    expect(unlimited.preview.evidence.dlx).toBe('not-applicable');
    expect(unlimited.preview.disposition).toEqual({
      kind: 'none',
      reason: 'unlimited',
    });
  });

  it('AC-1 does not apply before 4.3, where the target grants a fresh budget', () => {
    for (const era of ['3.13', '4.0-4.2'] as const) {
      const ok = draft(plan(era, { preflight: { dlxSources: evidence } }));
      expect(ok.preview.evidence.dlx, era).toBe('not-applicable');
    }
  });
});

describe('AC-2 3.13 x-delivery-limit=-1 is refused', () => {
  const minus1 = queueOf({
    deliveryLimit: { kind: 'unlimited' },
    limitState: 'minus1',
  });

  it('AC-2 refuses with LIMIT_MINUS1_313 on 3.13 and plans the same queue where -1 means unlimited', () => {
    expect(rejection(plan('3.13', { queue: minus1 }))).toMatchObject({
      code: 'LIMIT_MINUS1_313',
      reasons: ['limit-minus1-destructive'],
    });
    const older = draft(plan('4.0-4.2', { queue: minus1 }));
    expect(ids(older.warnings)).toContain('W-TAIL');
    const newer = draft(plan('4.3', { queue: minus1 }));
    expect(ids(newer.warnings)).not.toContain('W-TAIL');
    // 3.13 with no limit at all is not the same thing: unset means unlimited there.
    const unset = draft(
      plan('3.13', {
        queue: queueOf({
          deliveryLimit: { kind: 'unlimited' },
          limitState: 'unset',
        }),
      }),
    );
    expect(ids(unset.warnings)).toEqual(
      expect.arrayContaining(['W-313', 'W-TAIL']),
    );
  });
});

describe('AC-3 a 4.0-4.2 quorum queue with L=20', () => {
  const ttl = queueOf({ ttlMs: 60_000 });

  it('AC-3 needs W-BUDGET consent, caps 20 and 50 (administrators 200) and the hold formula', () => {
    const user = draft(plan('4.0-4.2', { queue: ttl }));
    expect(ids(user.warnings)).toContain('W-BUDGET');
    expect(user.consentsRequired).toContain('W-BUDGET');
    expect(user.preview.limit).toMatchObject({
      basis: 'finite',
      value: 20,
      estimated: false,
    });
    expect(user.preview.guard).toMatchObject({
      counter: 'x-delivery-count',
      doomedWhen: '>=',
      limit: { kind: 'finite', value: 20 },
      stopAtFirstDoomed: true,
    });
    expect(user.preview.caps).toMatchObject({
      requested: 20,
      count: 20,
      limitedBy: 'request',
    });
    // min(30 s, ttl / 4 = 15 s, channel timeout - 90 s = 1,710 s)
    expect(user.preview.hold).toEqual({
      targetMs: 5_000,
      hardAbortMs: 15_000,
      derivedFrom: ['message-ttl'],
    });

    const wantsMore = { count: 200 };
    expect(
      draft(plan('4.0-4.2', { queue: ttl, request: wantsMore })).preview.caps,
    ).toMatchObject({ count: 50, limitedBy: 'cap' });
    expect(
      draft(
        plan('4.0-4.2', {
          queue: ttl,
          request: wantsMore,
          profileOptions: { admin: true },
        }),
      ).preview.caps,
    ).toMatchObject({ count: 200, limitedBy: 'cap' });
    expect(user.preview.expected).toHaveLength(1);
    expect(user.preview.expected[0]).toMatchObject({
      cell: 'SEM-4.0-4.2-quorum-amqp091-amqp091.nack_requeue-limit-finite',
      effect: { deltaAC: 1, countsTowardLimit: 'yes' },
    });
    expect(user.preview.confidence).toBe('code-derived');
    expect(user.preview.semanticsVersion).toMatch(/^sem-/);
  });

  it('AC-3 uses the channel-level formula where the cells say so and the queue-level one where they do not', () => {
    const slow = queueOf({ consumerTimeoutMs: 100_000 });
    expect(draft(plan('4.0-4.2', { queue: slow })).preview.hold).toMatchObject({
      hardAbortMs: 10_000,
      derivedFrom: ['channel-timeout'],
    });
    const slow43 = queue43({ consumerTimeoutMs: 60_000 });
    expect(draft(plan('4.3', { queue: slow43 })).preview.hold).toMatchObject({
      hardAbortMs: 15_000,
      derivedFrom: ['consumer-timeout'],
    });
  });
});

describe('a classic queue', () => {
  it('is planned with get, no disposition and an honest "not in the registry"', () => {
    for (const era of ['3.13', '4.0-4.2', '4.3', '4.4'] as const) {
      const ok = draft(plan(era, { queue: classicQueue() }));
      expect(ok.preview.method, era).toBe('amqp091.get');
      expect(ok.preview.disposition).toEqual({
        kind: 'none',
        reason: 'classic',
      });
      expect(ok.preview.effects).toBe('not-in-registry');
      expect(ok.preview.expected).toEqual([]);
      expect(ok.preview.gaps).toEqual([]);
      expect(ok.consentsRequired).toEqual([]);
      expect(ids(ok.warnings)).toEqual(['W-CRASH', 'W-HOLD', 'W-REDELIVERED']);
      expect(ok.preview.honestLabelKey).toBe('peek-planner.honestLabel.v1');
    }
  });
});

describe('AC-7 gates reject in the documented order', () => {
  const gateOff = (era: Era): PeekProfile => ({
    ...profileOf(era),
    gates: {
      [FeatureIdSchema.parse('messages.peek')]: {
        enabled: false,
        reason: 'switched off',
      },
    },
  });
  const code = (result: PeekPlanDraft | PeekRejection): string =>
    rejection(result).code;

  it('AC-7 gives each cause its code', () => {
    expect(code(plan('4.3', { request: { count: 0 } }))).toBe(
      'INVALID_REQUEST',
    );
    expect(code(plan('4.3', { profile: gateOff('4.3') }))).toBe('GATE');
    const stream = rejection(
      plan('4.3', { queue: queueOf({ type: 'stream' }) }),
    );
    expect(stream.code).toBe('STREAM_QUEUE');
    expect(ids(stream.warnings)).toEqual(['W-STREAM']);
    const exclusive = rejection(
      plan('4.3', { queue: queue43({ exclusiveOwnedByOther: true }) }),
    );
    expect(exclusive.code).toBe('EXCLUSIVE');
    expect(ids(exclusive.warnings)).toEqual(['W-EXCLUSIVE']);
    expect(code(plan('4.3', { queue: queue43({ quorumOk: false }) }))).toBe(
      'NO_QUORUM',
    );
    expect(code(plan('4.3', { queue: queue43({ quorumOk: undefined }) }))).toBe(
      'NO_QUORUM',
    );
    expect(
      code(
        plan('4.3', {
          queue: queue43({
            singleActiveConsumer: true,
            hasActiveConsumer: true,
          }),
        }),
      ),
    ).toBe('SAC_ACTIVE');
    expect(
      code(
        plan('4.3', {
          profileOptions: { verification: 'unknown-build' },
          principal: mcpClient,
        }),
      ),
    ).toBe('UNVERIFIED_BROKER');
  });

  it('AC-7 reports the first cause when there are two', () => {
    const q = (extra: Partial<PreflightQueue>) => queue43(extra);
    // invalid beats everything; the gate beats a stream
    expect(
      code(plan('4.3', { request: { count: 1.5 }, profile: gateOff('4.3') })),
    ).toBe('INVALID_REQUEST');
    expect(
      code(
        plan('4.3', { queue: q({ type: 'stream' }), profile: gateOff('4.3') }),
      ),
    ).toBe('GATE');
    // stream, exclusive, unverified, quorum health, single active consumer: in that order
    expect(
      code(
        plan('4.3', {
          queue: q({ type: 'stream', exclusiveOwnedByOther: true }),
        }),
      ),
    ).toBe('STREAM_QUEUE');
    expect(
      code(
        plan('4.3', {
          queue: q({ exclusiveOwnedByOther: true, quorumOk: false }),
          profileOptions: { verification: 'unknown-build' },
          principal: mcpClient,
        }),
      ),
    ).toBe('EXCLUSIVE');
    expect(
      code(
        plan('4.3', {
          queue: q({ quorumOk: false }),
          profileOptions: { verification: 'unknown-build' },
          principal: mcpClient,
        }),
      ),
    ).toBe('UNVERIFIED_BROKER');
    expect(
      code(
        plan('4.3', {
          queue: q({
            quorumOk: false,
            singleActiveConsumer: true,
            hasActiveConsumer: true,
          }),
        }),
      ),
    ).toBe('NO_QUORUM');
    // a destroyed message before the dead-letter hazard before the budget before the method
    const minus1 = {
      deliveryLimit: { kind: 'unlimited' } as const,
      limitState: 'minus1' as const,
      singleActiveConsumer: true,
      hasActiveConsumer: true,
    };
    expect(code(plan('3.13', { queue: queueOf(minus1) }))).toBe('SAC_ACTIVE');
    expect(
      code(
        plan('3.13', {
          queue: queueOf({
            ...minus1,
            hasActiveConsumer: false,
            singleActiveConsumer: false,
          }),
          preflight: { rttMs: Number.NaN },
        }),
      ),
    ).toBe('LIMIT_MINUS1_313');
    const sources = {
      sources: [{ queue: 'orders', limit: finite(20) }],
      complete: true,
      unknownReasons: [],
    };
    expect(
      code(
        plan('4.3', {
          queue: queue43(),
          preflight: { dlxSources: sources, rttMs: Number.NaN },
        }),
      ),
    ).toBe('OVERLIMIT_DLQ');
    expect(
      code(
        plan('4.3', {
          queue: queue43({
            deliveryLimit: { kind: 'unlimited' },
            limitState: 'minus1',
          }),
          preflight: { rttMs: Number.NaN },
          request: { prefer: 'http-fallback' },
        }),
      ),
    ).toBe('BUDGET_TOO_SMALL');
    expect(
      code(
        plan('4.3', {
          queue: queue43(),
          request: { prefer: 'http-fallback' },
          preflight: { rescue: undefined },
        }),
      ),
    ).toBe('METHOD_UNAVAILABLE');
    expect(
      code(plan('4.3', { queue: queue43(), preflight: { rescue: undefined } })),
    ).toBe('NO_SAFE_DISPOSITION');
  });

  it('AC-7 refuses a request or a preflight with numbers that are not numbers', () => {
    const bad = (setup: Setup) => rejection(plan('4.3', setup));
    expect(bad({ request: { count: Number.NaN } }).reasons).toEqual([
      'count-invalid',
    ]);
    expect(
      bad({ request: { count: Number.MAX_SAFE_INTEGER + 2 } }).reasons,
    ).toEqual(['count-invalid']);
    expect(bad({ request: { maxBytes: 0 } }).reasons).toEqual([
      'max-bytes-invalid',
    ]);
    expect(bad({ request: { queue: 'no key!' as never } }).reasons).toEqual([
      'queue-key-invalid',
    ]);
    for (const extra of [
      { ttlMs: -1 },
      { avgBytes: Number.NaN },
      { ready: Number.POSITIVE_INFINITY },
      { consumerTimeoutMs: -5 },
      { maxLength: Number.NaN },
    ]) {
      expect(
        bad({ queue: queue43(extra) }).reasons,
        JSON.stringify(extra),
      ).toEqual(['preflight-number-invalid']);
    }
    expect(bad({ request: { count: 0, maxBytes: -1 } }).reasons).toEqual([
      'count-invalid',
      'max-bytes-invalid',
    ]);
  });
});

describe('AC-8 incomplete evidence at plan level (A-2)', () => {
  const incomplete = {
    sources: [],
    complete: false,
    unknownReasons: [{ code: 'truncated' }],
  };

  it('AC-8 plans a finite-unknown limit for a person, with the estimate and no shortcut', () => {
    const ok = draft(
      plan('4.3', {
        queue: queue43({ visibleLimits: [50, 12] }),
        preflight: { dlxSources: incomplete },
      }),
    );
    expect(ids(ok.warnings)).toContain('W-DLX-UNVERIFIED');
    expect(ok.consentsRequired).toContain('W-DLX-UNVERIFIED');
    expect(ok.preview.limit).toMatchObject({
      basis: 'finite-unknown',
      value: 12,
      estimated: true,
      reasons: ['dlx-evidence-unverified'],
    });
    expect(ok.preview.guard).toMatchObject({
      limit: { kind: 'finite', value: 12 },
      estimated: true,
    });
    expect(ok.preview.evidence.dlx).toBe('unknown');
    expect(ok.preview.disposition.kind).toBe('quarantine');
  });

  it('AC-8 estimates 20 when nothing lower is visible, and for an unknown own limit', () => {
    const own = draft(
      plan('4.3', { queue: queue43({ deliveryLimit: { kind: 'unknown' } }) }),
    );
    expect(ids(own.warnings)).toContain('W-LIMIT-UNKNOWN');
    expect(own.preview.guard.limit).toEqual({ kind: 'finite', value: 20 });
    expect(own.preview.limit.reasons).toEqual(['own-limit-unknown']);
  });

  it('AC-8 stops AI and unattended runs, and treats an empty complete list as no hazard', () => {
    for (const principal of [mcpClient, unattended]) {
      expect(
        rejection(
          plan('4.3', {
            queue: queue43(),
            preflight: { dlxSources: incomplete },
            principal,
          }),
        ),
      ).toMatchObject({
        code: 'NO_SAFE_DISPOSITION',
        reasons: ['dlx-evidence-unverified'],
      });
    }
    const ok = draft(
      plan('4.3', {
        queue: queue43(),
        principal: unattended,
        preflight: {
          dlxSources: { sources: [], complete: true, unknownReasons: [] },
        },
      }),
    );
    expect(ids(ok.warnings)).not.toContain('W-DLX-UNVERIFIED');
    expect(ok.preview.disposition).toMatchObject({
      kind: 'quarantine',
      chosenBy: 'default',
    });
  });
});

describe('AC-18 an unverified build is conservative', () => {
  it('AC-18 asks a person for consent and caps conservatively; it refuses an AI run', () => {
    const options: ProfileOptions = { verification: 'unknown-build' };
    const ok = draft(
      plan('4.3', {
        queue: queue43(),
        request: { count: 500 },
        profileOptions: options,
      }),
    );
    expect(ids(ok.warnings)).toContain('W-BROKER-UNVERIFIED');
    expect(ok.consentsRequired).toContain('W-BROKER-UNVERIFIED');
    expect(ok.preview.confidence).toBe('unverified-version');
    expect(ok.preview.caps).toMatchObject({ count: 20, limitedBy: 'cap' });
    const verified = draft(
      plan('4.3', { queue: queue43(), request: { count: 500 } }),
    );
    expect(verified.preview.caps.count).toBe(500);
    expect(verified.preview.confidence).toBe('code-derived');
    expect(
      rejection(
        plan('4.3', {
          queue: queue43(),
          profileOptions: options,
          principal: unattended,
        }),
      ).code,
    ).toBe('UNVERIFIED_BROKER');
  });
});

describe('the plan names the disposition and what it asks of a person', () => {
  it('adds the let-broker-handle consent and sorts every list', () => {
    const ok = draft(
      plan('4.0-4.2', {
        queue: queueOf({
          ttlMs: 60_000,
          overflow: 'drop-head',
          maxLength: 100,
          ready: 95,
        }),
        request: {
          disposition: {
            kind: 'let-broker-handle',
            typedConsent: 'orders.dlq',
          },
        },
        preflight: { rescue: rescueOf({ queueReady: false }) },
      }),
    );
    expect(ok.preview.disposition).toEqual({
      kind: 'let-broker-handle',
      chosenBy: 'request',
    });
    expect(ok.consentsRequired).toEqual([
      'W-BUDGET',
      'W-DROPHEAD',
      'disposition:let-broker-handle',
    ]);
    expect(ids(ok.warnings)).toEqual([...ids(ok.warnings)].sort());
    expect(ok.gates).toEqual([]);
  });
});
