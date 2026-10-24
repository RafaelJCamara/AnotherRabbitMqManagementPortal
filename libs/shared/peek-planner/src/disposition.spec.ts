import type { Era } from '@app/domain-model';
import { semanticsRegistry } from '@app/semantics';
import { describe, expect, it } from 'vitest';

import {
  FRESH_MS,
  LET_BROKER_HANDLE_CONSENT,
  minus1IsSafe,
  planDisposition,
  queueNameOf,
  type DispositionInput,
  type DispositionOutcome,
} from './disposition.ts';
import { readLimit, type LimitView } from './limit.ts';
import {
  NOW,
  classicQueue,
  human,
  mcpClient,
  preflightOf,
  profileOf,
  queueOf,
  rescueOf,
  unattended,
} from './testing.ts';
import type { Disposition, PeekPrincipal, PreflightQueue } from './types.ts';
import { encodeObjectKey } from '@app/contracts';

interface Case {
  readonly era?: Era;
  readonly queue?: PreflightQueue;
  readonly principal?: PeekPrincipal;
  readonly requested?: Disposition | undefined;
  readonly admin?: boolean;
  readonly rescue?: ReturnType<typeof rescueOf> | undefined;
  readonly takenAt?: number;
  readonly managedPolicies?: readonly string[];
  readonly unknownReason?: DispositionInput['unknownReason'];
  readonly limit?: LimitView;
}

function run(c: Case = {}): DispositionOutcome {
  const queue = c.queue ?? queueOf();
  const preflight = preflightOf(queue, {
    rescue: 'rescue' in c ? c.rescue : rescueOf(),
    takenAt: c.takenAt ?? NOW - 1_000,
  });
  return planDisposition({
    registry: semanticsRegistry,
    era: c.era ?? '4.0-4.2',
    queueType: queue.type,
    queueName: 'orders.dlq',
    limit: c.limit ?? readLimit(queue),
    unknownReason: c.unknownReason ?? 'limit-unknown',
    requested: c.requested,
    profile: profileOf(c.era ?? '4.0-4.2', {
      admin: c.admin ?? false,
      ...(c.managedPolicies === undefined
        ? {}
        : { managedPolicies: c.managedPolicies }),
    }),
    preflight,
    principal: c.principal ?? human,
    nowMs: NOW,
  });
}

const rejected = (outcome: DispositionOutcome) => {
  if (outcome.ok) throw new Error('expected a rejection');
  return outcome.rejection;
};
const planned = (outcome: DispositionOutcome) => {
  if (!outcome.ok)
    throw new Error(`expected a disposition, got ${outcome.rejection.code}`);
  return outcome;
};

describe('R8 a disposition is mandatory for a finite or unknown limit only', () => {
  it('needs none for a classic queue or an unlimited quorum queue', () => {
    expect(planned(run({ queue: classicQueue() })).disposition).toEqual({
      kind: 'none',
      reason: 'classic',
    });
    expect(
      planned(
        run({
          queue: queueOf({
            deliveryLimit: { kind: 'unlimited' },
            limitState: 'minus1',
          }),
        }),
      ).disposition,
    ).toEqual({ kind: 'none', reason: 'unlimited' });
  });

  it('defaults to quarantine when its rescue check passes, for a person and for an AI run', () => {
    for (const principal of [human, mcpClient, unattended]) {
      expect(planned(run({ principal })).disposition).toEqual({
        kind: 'quarantine',
        queue: 'app.quarantine',
        chosenBy: 'default',
      });
    }
  });
});

describe('AC-4 an unattended principal with no safe disposition is refused', () => {
  it('AC-4 refuses with NO_SAFE_DISPOSITION and lists what a person could choose', () => {
    const noRescue = run({ principal: unattended, rescue: undefined });
    expect(rejected(noRescue)).toMatchObject({
      code: 'NO_SAFE_DISPOSITION',
      reasons: ['no-rescue', 'no-safe-disposition'],
      offers: [],
    });
    const person = rejected(run({ rescue: undefined }));
    expect(person.code).toBe('NO_SAFE_DISPOSITION');
    expect(person.offers).toEqual(['let-broker-handle']);
    // An administrator may also raise the limit (not while it is unknown).
    expect(rejected(run({ rescue: undefined, admin: true })).offers).toEqual([
      'let-broker-handle',
      'raise-limit',
    ]);
    // Nobody is offered "let the broker handle it" unless they are a person.
    expect(
      rejected(run({ rescue: undefined, principal: mcpClient })).offers,
    ).toEqual([]);
  });

  it('AC-4 refuses an unattended run when the rescue check is stale, and a person is not held to the age', () => {
    const stale = rescueOf({ checkedAt: NOW - FRESH_MS - 1 });
    expect(
      rejected(run({ principal: unattended, rescue: stale })),
    ).toMatchObject({
      code: 'NO_SAFE_DISPOSITION',
      reasons: ['no-safe-disposition', 'rescue-stale'],
    });
    expect(planned(run({ rescue: stale })).disposition.kind).toBe('quarantine');
    const edge = rescueOf({ checkedAt: NOW - FRESH_MS });
    expect(
      planned(run({ principal: unattended, rescue: edge })).disposition.kind,
    ).toBe('quarantine');
    const future = rescueOf({ checkedAt: NOW + 1 });
    expect(
      rejected(run({ principal: unattended, rescue: future })).reasons,
    ).toContain('rescue-stale');
  });
});

describe('AC-14 quarantine (A-1, A-5)', () => {
  const quarantine: Disposition = {
    kind: 'quarantine',
    queue: 'app.quarantine',
  };

  it('is accepted when its rescue check passes', () => {
    expect(planned(run({ requested: quarantine })).disposition).toEqual({
      kind: 'quarantine',
      queue: 'app.quarantine',
      chosenBy: 'request',
    });
  });

  it('names each failed check and is refused as RESCUE_PREFLIGHT_FAILED', () => {
    const cases: [Partial<ReturnType<typeof rescueOf>>, string][] = [
      [{ queueReady: false }, 'rescue-queue-not-ready'],
      [{ overflowSafe: false }, 'rescue-overflow-unsafe'],
      [{ permissionOk: false }, 'rescue-permission'],
      [{ alarms: ['disk'] }, 'rescue-alarm'],
      [{ publishBlocked: true }, 'rescue-publish-blocked'],
      [{ queueName: 'other.quarantine' }, 'no-rescue'],
    ];
    for (const [change, reason] of cases) {
      expect(
        rejected(run({ requested: quarantine, rescue: rescueOf(change) })),
        reason,
      ).toMatchObject({
        code: 'RESCUE_PREFLIGHT_FAILED',
        reasons: [reason],
      });
    }
    expect(
      rejected(
        run({
          requested: quarantine,
          rescue: rescueOf({
            queueReady: false,
            alarms: ['x'],
            publishBlocked: true,
          }),
        }),
      ).reasons,
    ).toEqual([
      'rescue-alarm',
      'rescue-publish-blocked',
      'rescue-queue-not-ready',
    ]);
    expect(
      rejected(run({ requested: quarantine, rescue: undefined })).reasons,
    ).toEqual(['no-rescue']);
  });

  it('is held to 60 s for AI and unattended runs only', () => {
    const stale = rescueOf({ checkedAt: NOW - 61_000 });
    for (const principal of [mcpClient, unattended]) {
      expect(
        rejected(run({ requested: quarantine, principal, rescue: stale })),
      ).toMatchObject({
        code: 'RESCUE_PREFLIGHT_FAILED',
        reasons: ['rescue-stale'],
      });
    }
    expect(
      planned(run({ requested: quarantine, rescue: stale })).disposition.kind,
    ).toBe('quarantine');
  });
});

describe('AC-14 raise-limit (A-4)', () => {
  const raise = (value: number, policyName = 'peek.raise'): Disposition => ({
    kind: 'raise-limit',
    policyName,
    value,
  });

  it('is for administrators only', () => {
    expect(rejected(run({ requested: raise(30) }))).toMatchObject({
      code: 'NO_SAFE_DISPOSITION',
      reasons: ['raise-limit-not-admin'],
    });
    expect(
      planned(run({ requested: raise(30), admin: true })).disposition,
    ).toEqual({
      kind: 'raise-limit',
      policyName: 'peek.raise',
      value: 30,
      chosenBy: 'request',
    });
  });

  it('needs a finite value above the current limit, or -1 where -1 keeps the head', () => {
    const admin = true;
    expect(rejected(run({ requested: raise(20), admin }))).toMatchObject({
      code: 'INVALID_REQUEST',
      reasons: ['raise-limit-value-invalid'],
    });
    expect(rejected(run({ requested: raise(5), admin })).code).toBe(
      'INVALID_REQUEST',
    );
    expect(rejected(run({ requested: raise(2.5), admin })).code).toBe(
      'INVALID_REQUEST',
    );
    expect(rejected(run({ requested: raise(0), admin })).code).toBe(
      'INVALID_REQUEST',
    );
    expect(rejected(run({ requested: raise(Number.NaN), admin })).code).toBe(
      'INVALID_REQUEST',
    );
    // 4.0-4.2: -1 sends returns to the tail. 3.13: -1 drops. 4.3: -1 keeps the head.
    expect(
      rejected(run({ requested: raise(-1), admin, era: '4.0-4.2' })).code,
    ).toBe('INVALID_REQUEST');
    expect(
      rejected(run({ requested: raise(-1), admin, era: '3.13' })).code,
    ).toBe('INVALID_REQUEST');
    expect(
      planned(run({ requested: raise(-1), admin, era: '4.3' })).disposition,
    ).toMatchObject({
      kind: 'raise-limit',
      value: -1,
    });
    // 4.4 has no cells: the substitute is not proof, so -1 is not offered.
    expect(
      rejected(run({ requested: raise(-1), admin, era: '4.4' })).code,
    ).toBe('INVALID_REQUEST');
  });

  it('is impossible while the limit is unknown, or when an argument or operator policy fixes it', () => {
    const unknown = queueOf({ deliveryLimit: { kind: 'unknown' } });
    expect(
      rejected(run({ requested: raise(30), admin: true, queue: unknown }))
        .reasons,
    ).toEqual(['raise-limit-unknown-limit']);
    for (const limitFixedBy of ['argument', 'operator-policy'] as const) {
      expect(
        rejected(
          run({
            requested: raise(30),
            admin: true,
            queue: queueOf({ limitFixedBy }),
          }),
        ),
      ).toMatchObject({
        code: 'NO_SAFE_DISPOSITION',
        reasons: ['raise-limit-capped'],
      });
    }
    expect(
      planned(
        run({
          requested: raise(30),
          admin: true,
          queue: queueOf({ limitFixedBy: null }),
        }),
      ).disposition.kind,
    ).toBe('raise-limit');
  });

  it('never touches nsb.* or a policy a provider owns', () => {
    expect(
      rejected(run({ requested: raise(30, 'nsb.retries'), admin: true }))
        .reasons,
    ).toEqual(['raise-limit-protected-name']);
    expect(
      rejected(
        run({
          requested: raise(30),
          admin: true,
          managedPolicies: ['peek.raise'],
        }),
      ).reasons,
    ).toEqual(['raise-limit-protected-name']);
  });

  it('reports every block at once, sorted', () => {
    expect(
      rejected(
        run({
          requested: raise(30, 'nsb.x'),
          queue: queueOf({ limitFixedBy: 'argument' }),
        }),
      ).reasons,
    ).toEqual([
      'raise-limit-capped',
      'raise-limit-not-admin',
      'raise-limit-protected-name',
    ]);
  });

  it('needs a fresh preflight for AI and unattended runs', () => {
    const takenAt = NOW - FRESH_MS - 1;
    expect(
      rejected(
        run({
          requested: raise(30),
          admin: true,
          principal: unattended,
          takenAt,
        }),
      ).reasons,
    ).toEqual(['raise-limit-stale']);
    expect(
      planned(run({ requested: raise(30), admin: true, principal: unattended }))
        .disposition.kind,
    ).toBe('raise-limit');
    expect(
      planned(run({ requested: raise(30), admin: true, takenAt })).disposition
        .kind,
    ).toBe('raise-limit');
  });

  it('asks the registry whether -1 is safe (I-3)', () => {
    expect(minus1IsSafe(semanticsRegistry, '4.3')).toBe(true);
    expect(minus1IsSafe(semanticsRegistry, '4.0-4.2')).toBe(false);
    expect(minus1IsSafe(semanticsRegistry, '3.13')).toBe(false);
    expect(minus1IsSafe(semanticsRegistry, '4.4')).toBe(false);
  });
});

describe('AC-14 let-broker-handle (DC-09)', () => {
  const handle = (typedConsent: string): Disposition => ({
    kind: 'let-broker-handle',
    typedConsent,
  });

  it('is for a person who types the queue name, and adds its consent', () => {
    const outcome = planned(run({ requested: handle('orders.dlq') }));
    expect(outcome.disposition).toEqual({
      kind: 'let-broker-handle',
      chosenBy: 'request',
    });
    expect(outcome.consents).toEqual([LET_BROKER_HANDLE_CONSENT]);
    expect(rejected(run({ requested: handle('orders') }))).toMatchObject({
      code: 'INVALID_REQUEST',
      reasons: ['typed-consent-mismatch'],
    });
    expect(rejected(run({ requested: handle('') })).code).toBe(
      'INVALID_REQUEST',
    );
  });

  it('is never accepted for an AI run, an unattended run or a job, whatever they type', () => {
    for (const principal of [
      mcpClient,
      unattended,
      { ...human, onBehalfOf: mcpClient },
    ]) {
      expect(
        rejected(run({ requested: handle('orders.dlq'), principal })),
      ).toMatchObject({
        code: 'NO_SAFE_DISPOSITION',
        reasons: ['let-broker-handle-non-human'],
      });
    }
  });

  it('is never chosen by default', () => {
    expect(rejected(run({ rescue: undefined })).code).toBe(
      'NO_SAFE_DISPOSITION',
    );
  });
});

describe('AC-8 a finite-unknown limit stops non-human runs (A-2)', () => {
  const unknownQueue = queueOf({ deliveryLimit: { kind: 'unknown' } });

  it('stops every non-human principal, whatever they ask for', () => {
    for (const principal of [mcpClient, unattended]) {
      for (const requested of [
        undefined,
        { kind: 'quarantine', queue: 'app.quarantine' } as const,
        { kind: 'let-broker-handle', typedConsent: 'orders.dlq' } as const,
      ]) {
        expect(
          rejected(run({ queue: unknownQueue, principal, requested })),
        ).toMatchObject({
          code: 'NO_SAFE_DISPOSITION',
          reasons: ['limit-unknown'],
        });
      }
    }
    // The limit is known but the dead-letter evidence is not: the same stop, with its own reason.
    const byEvidence: LimitView = {
      basis: 'finite-unknown',
      state: 'finite',
      reasons: ['dlx-evidence-unverified'],
    };
    expect(
      rejected(
        run({
          principal: unattended,
          limit: byEvidence,
          unknownReason: 'dlx-evidence-unverified',
        }),
      ),
    ).toMatchObject({
      code: 'NO_SAFE_DISPOSITION',
      reasons: ['dlx-evidence-unverified'],
    });
  });

  it('lets a person quarantine, and says why a non-human run stopped', () => {
    expect(planned(run({ queue: unknownQueue })).disposition.kind).toBe(
      'quarantine',
    );
  });
});

describe('queueNameOf', () => {
  it('decodes the name of an object key and refuses a key that is not one', () => {
    expect(queueNameOf(encodeObjectKey('/', 'orders.dlq'))).toBe('orders.dlq');
    expect(queueNameOf('not a key !!' as never)).toBeUndefined();
  });
});
