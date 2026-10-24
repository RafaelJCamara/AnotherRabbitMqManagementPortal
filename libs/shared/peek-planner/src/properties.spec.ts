import { semanticsRegistry, type DeliveryLimit } from '@app/semantics';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { planPeek } from './plan.ts';
import { isHumanInteractive } from './principal.ts';
import { isRejection } from './rejections.ts';
import {
  NOW,
  factsOf,
  human,
  mcpClient,
  preflightOf,
  profileOf,
  queueOf,
  requestOf,
  rescueOf,
  unattended,
} from './testing.ts';
import type { Disposition, PreflightQueue } from './types.ts';

const ERAS = ['3.13', '4.0-4.2', '4.3', '4.4'] as const;

const finiteLimit = (value: number): DeliveryLimit => ({
  kind: 'finite',
  value,
});
const UNLIMITED: DeliveryLimit = { kind: 'unlimited' };
const UNKNOWN: DeliveryLimit = { kind: 'unknown' };

interface LimitShape {
  readonly deliveryLimit: DeliveryLimit;
  readonly limitState: PreflightQueue['limitState'];
}

const limitArb: fc.Arbitrary<LimitShape> = fc.oneof(
  fc.integer({ min: 1, max: 60 }).map(
    (value): LimitShape => ({
      deliveryLimit: finiteLimit(value),
      limitState: 'finite',
    }),
  ),
  fc
    .constantFrom<PreflightQueue['limitState']>('unset', 'minus1')
    .map(
      (limitState): LimitShape => ({ deliveryLimit: UNLIMITED, limitState }),
    ),
  fc.constant<LimitShape>({ deliveryLimit: UNKNOWN, limitState: 'finite' }),
  // an incoherent pair
  fc.constant<LimitShape>({
    deliveryLimit: finiteLimit(20),
    limitState: 'minus1',
  }),
);

interface SourceShape {
  readonly queue: string;
  readonly limit: DeliveryLimit;
}

const sourceArb: fc.Arbitrary<SourceShape> = fc.record({
  queue: fc.constantFrom('a', 'b', 'c'),
  limit: fc.oneof(
    fc.integer({ min: 1, max: 60 }).map(finiteLimit),
    fc.constant(UNLIMITED),
    fc.constant(UNKNOWN),
  ),
});

const dispositionArb: fc.Arbitrary<Disposition | undefined> = fc.oneof(
  fc.constant<Disposition | undefined>(undefined),
  fc.constant<Disposition | undefined>({
    kind: 'quarantine',
    queue: 'app.quarantine',
  }),
  fc.integer({ min: -1, max: 80 }).map(
    (value): Disposition => ({
      kind: 'raise-limit',
      policyName: 'peek.raise',
      value,
    }),
  ),
  fc.constantFrom('orders.dlq', 'wrong').map(
    (typedConsent): Disposition => ({
      kind: 'let-broker-handle',
      typedConsent,
    }),
  ),
);

const scenarioArb = fc.record({
  era: fc.constantFrom(...ERAS),
  type: fc.constantFrom('classic', 'quorum', 'quorum', 'quorum', 'stream'),
  limit: limitArb,
  sources: fc.array(sourceArb, { maxLength: 4 }),
  complete: fc.boolean(),
  held: fc.option(fc.array(fc.constantFrom('a', 'x', 'y'), { maxLength: 2 }), {
    nil: undefined,
  }),
  principal: fc.constantFrom(human, mcpClient, unattended),
  admin: fc.boolean(),
  verified: fc.boolean(),
  disposition: dispositionArb,
  prefer: fc.constantFrom(undefined, 'amqp091', 'amqp10-step', 'http-fallback'),
  count: fc.integer({ min: 1, max: 600 }),
  rescue: fc.constantFrom('ok', 'stale', 'blocked', 'absent'),
  ttl: fc.option(fc.integer({ min: 1_000, max: 600_000 }), { nil: undefined }),
  rtt: fc.integer({ min: 1, max: 800 }),
  sac: fc.boolean(),
  delayed: fc.constantFrom(undefined, 'disabled', 'all', 'failed', 'returned'),
});

type ScenarioValue =
  typeof scenarioArb extends fc.Arbitrary<infer T> ? T : never;

function run(s: ScenarioValue) {
  const queue = queueOf({
    type: s.type,
    ...(s.type === 'quorum'
      ? s.limit
      : { deliveryLimit: { kind: 'unlimited' }, limitState: 'unset' }),
    singleActiveConsumer: s.sac,
    ttlMs: s.ttl,
    ...(s.delayed === undefined ? {} : { delayedRetry: { type: s.delayed } }),
  });
  const rescue =
    s.rescue === 'absent'
      ? undefined
      : rescueOf(
          s.rescue === 'stale'
            ? { checkedAt: NOW - 120_000 }
            : s.rescue === 'blocked'
              ? { publishBlocked: true }
              : {},
        );
  const request = requestOf({
    count: s.count,
    disposition: s.disposition,
    prefer: s.prefer,
  });
  const preflight = preflightOf(queue, {
    dlxSources: {
      sources: s.sources,
      complete: s.complete,
      unknownReasons: s.complete ? [] : [{ code: 'truncated' }],
    },
    heldDeathSources: s.held,
    rescue,
    rttMs: s.rtt,
  });
  const facts = factsOf(s.era, preflight, {
    principal: s.principal,
    profile: profileOf(s.era, {
      admin: s.admin,
      verification: s.verified ? 'verified' : 'unknown-build',
    }),
  });
  return { request, facts, queue, rescue, result: planPeek(request, facts) };
}

describe('properties of the planner', () => {
  it('is total: any scenario gives a plan or a rejection with a code, reasons and a key', () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const { result } = run(s);
        if (isRejection(result)) {
          expect(result.reasons.length).toBeGreaterThan(0);
          expect(result.textKey).toMatch(
            /^peek-planner\.rejections\.[A-Z_0-9]+\.v1$/,
          );
        } else {
          expect(result.preview.honestLabelKey).toMatch(/^peek-planner\./);
        }
      }),
      { numRuns: 600 },
    );
  });

  it('never plans what A-1, A-2 and DC-09 forbid', () => {
    let drafts = 0;
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const { result, facts, rescue } = run(s);
        if (isRejection(result)) return;
        drafts += 1;
        const preview = result.preview;
        const person = isHumanInteractive(facts.principal);
        // a stream is never planned; a classic or quorum queue is
        expect(['classic', 'quorum']).toContain(preview.queueType);
        // a finite or unknown limit always has a disposition
        if (
          preview.queueType === 'quorum' &&
          preview.limit.basis !== 'unlimited'
        ) {
          expect(preview.disposition.kind).not.toBe('none');
        }
        if (!person) {
          // nobody watches: no broker handling, no unknown limit, no substituted row, a verified build
          expect(preview.disposition.kind).not.toBe('let-broker-handle');
          expect(preview.limit.basis).not.toBe('finite-unknown');
          expect(preview.gaps).toEqual([]);
          expect(preview.verification).toBe('verified');
          expect(result.consentsRequired).not.toContain(
            'disposition:let-broker-handle',
          );
          if (preview.disposition.kind === 'quarantine') {
            const age = NOW - (rescue?.checkedAt ?? Number.NEGATIVE_INFINITY);
            expect(age).toBeGreaterThanOrEqual(0);
            expect(age).toBeLessThanOrEqual(60_000);
          }
        }
        // a quarantine needs a rescue check that passed
        if (preview.disposition.kind === 'quarantine') {
          expect(rescue).toBeDefined();
          expect(rescue).toMatchObject({
            queueReady: true,
            overflowSafe: true,
            permissionOk: true,
            publishBlocked: false,
            alarms: [],
          });
        }
        // raising the limit is for administrators and never with an unknown limit
        if (preview.disposition.kind === 'raise-limit') {
          expect(facts.profile.identity.isAdmin).toBe(true);
          expect(preview.limit.basis).toBe('finite');
        }
        // the HTTP fallback never stands in for the guard
        if (preview.method === 'http.get_fallback') {
          expect(preview.guard.limit.kind === 'unlimited').toBe(true);
          expect(preview.caps.count).toBeLessThanOrEqual(50);
          expect(preview.disposition.kind).toBe('none');
        }
      }),
      { numRuns: 800 },
    );
    // The generator must reach plans, or these properties would hold vacuously.
    expect(drafts).toBeGreaterThan(50);
  });

  it('keeps every number inside its bound', () => {
    let drafts = 0;
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const { result, facts } = run(s);
        if (isRejection(result)) return;
        drafts += 1;
        const { caps, hold } = result.preview;
        const row = semanticsRegistry.peekCaps(
          result.preview.era,
          result.preview.queueType,
          facts.profile.identity.isAdmin ? 'admin' : 'user',
          result.preview.verification,
        );
        expect(caps.count).toBeGreaterThanOrEqual(1);
        expect(caps.count).toBeLessThanOrEqual(Math.min(s.count, row.max));
        expect(caps.bytes).toBeLessThanOrEqual(row.maxBytes);
        expect(hold.hardAbortMs).toBeLessThanOrEqual(30_000);
        expect(hold.targetMs).toBeLessThanOrEqual(
          Math.min(5_000, hold.hardAbortMs),
        );
        expect(caps.count * facts.preflight.rttMs).toBeLessThanOrEqual(
          hold.targetMs,
        );
        if (s.ttl !== undefined) {
          expect(hold.hardAbortMs).toBeLessThanOrEqual(Math.floor(s.ttl / 4));
        }
      }),
      { numRuns: 600 },
    );
    // The generator must reach plans, or these properties would hold vacuously.
    expect(drafts).toBeGreaterThan(50);
  });

  it('lists warnings once, sorted, and asks for every consent the registry marks', () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const { result } = run(s);
        if (isRejection(result)) return;
        const idList = result.warnings.map((w) => w.id);
        expect(idList).toEqual([...new Set(idList)].sort());
        expect(result.consentsRequired).toEqual(
          [...new Set(result.consentsRequired)].sort(),
        );
        for (const warning of result.warnings) {
          if (warning.severity === 'consent') {
            expect(result.consentsRequired).toContain(warning.id);
          }
          expect(warning.severity).not.toBe('block');
        }
      }),
      { numRuns: 400 },
    );
  });

  it('blocks a finite limit that a dead-letter source can push over, wherever the count is carried', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('4.3', '4.4' as const),
        fc.integer({ min: 1, max: 60 }),
        fc.integer({ min: 1, max: 60 }),
        (era, own, source) => {
          const result = planPeek(
            requestOf(),
            factsOf(
              era,
              preflightOf(
                queueOf({
                  deliveryLimit: { kind: 'finite', value: own },
                  delayedRetry: { type: 'disabled' },
                }),
                {
                  dlxSources: {
                    sources: [
                      { queue: 'a', limit: { kind: 'finite', value: source } },
                    ],
                    complete: true,
                    unknownReasons: [],
                  },
                },
              ),
            ),
          );
          // An independent oracle: arrival Ls + 1, one failed delivery more, dropped when above L.
          const blocked = source + 2 > own;
          expect(isRejection(result) && result.code === 'OVERLIMIT_DLQ').toBe(
            blocked,
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});
