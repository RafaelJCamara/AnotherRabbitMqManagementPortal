import { ConnectionIdSchema, encodeObjectKey } from '@app/contracts';
import type { ConnectionId } from '@app/contracts';
import type { Era } from '@app/domain-model';
import { createManualClock } from '@app/kernel';
import {
  isRejection,
  planPeek,
  type Disposition,
  type PeekPrincipal,
  type PeekPreflight,
  type PeekProfile,
} from '@app/peek-planner';
import type { Principal } from '@app/ports';
import { semanticsRegistry } from '@app/semantics';
import { describe, expect, it } from 'vitest';

import {
  createFakeEvidence,
  createScriptedManagement,
  healthyNodes,
  openPermission,
  peekedQuorumRow,
  policyRow,
  profileOf,
  quarantineRow,
  type ProfileOptions,
  type VhostDescription,
} from './preflight-fakes.ts';
import { createPeekPreflight, type PreflightOutcome } from './preflight.ts';
import { type RescueRegistry } from './rescue-preflight.ts';

const CID = 'conn-1' as ConnectionId;
const VHOST = '/';
const NOW = 1_800_000_000_000;
const QUARANTINE = 'product.quarantine';
const signal = new AbortController().signal;

const caller: Principal = {
  kind: 'desktop-user',
  id: 'u1',
  display: 'Ada',
  roles: [],
  surface: 'ui',
  unattended: false,
};
const human: PeekPrincipal = {
  kind: 'desktop-user',
  surface: 'ui',
  unattended: false,
};

interface Scenario extends Partial<VhostDescription> {
  readonly profile?: ProfileOptions;
  readonly registry?: RescueRegistry;
}

function setup(scenario: Scenario = {}) {
  const { profile, registry, ...vhost } = scenario;
  const clock = createManualClock(NOW);
  const api = createScriptedManagement({
    nodes: healthyNodes,
    user: 'ada',
    permission: openPermission,
    ...vhost,
    vhost: VHOST,
    queues: { orders: peekedQuorumRow, ...vhost.queues },
  });
  const service = createPeekPreflight({
    mgmt: api.mgmt,
    evidence: createFakeEvidence(),
    clock,
    quarantinePrefix: 'product',
    ...(registry === undefined ? {} : { registry }),
  });
  const run = (rescue: 'check' | 'skip' = 'check') =>
    service.run(
      {
        connectionId: CID,
        vhost: VHOST,
        queue: 'orders',
        principal: caller,
        profile: profileOf(profile),
        rescue,
      },
      signal,
    );
  return { api, clock, run };
}

/** The real planner over a preflight, asked for the quarantine unless told otherwise. */
function plan(
  preflight: PeekPreflight,
  options: {
    readonly era?: Era;
    readonly principal?: PeekPrincipal;
    readonly nowMs?: number;
    readonly disposition?: Disposition | null;
  } = {},
) {
  const pf = profileOf(options.era === undefined ? {} : { era: options.era });
  const profile: PeekProfile = {
    ...pf,
    verification: 'verified',
    managedObjects: [],
    gates: {},
  };
  const disposition =
    options.disposition === undefined
      ? ({ kind: 'quarantine', queue: QUARANTINE } as const)
      : options.disposition;
  return planPeek(
    {
      connectionId: ConnectionIdSchema.parse('lab'),
      queue: encodeObjectKey(VHOST, 'orders'),
      count: 5,
      ...(disposition === null ? {} : { disposition }),
    },
    {
      profile,
      preflight,
      principal: options.principal ?? human,
      registry: semanticsRegistry,
      env: 'dev',
      nowMs: options.nowMs ?? NOW,
    },
  );
}

/** The rescue result of an outcome that ran the check. */
function rescueOf(outcome: PreflightOutcome) {
  if (outcome.rescue === null) throw new Error('the rescue check did not run');
  return outcome.rescue;
}

const reasonsOf = (planned: ReturnType<typeof plan>): readonly string[] =>
  isRejection(planned) ? planned.reasons : [];

describe('rescue preflight', () => {
  it('M1-13 AC-10 an all-queues max-length reject-publish policy is matched, reported and answered with explicit arguments', async () => {
    const { run, api } = setup({
      policies: [
        policyRow({ 'max-length': 1_000, overflow: 'reject-publish' }),
      ],
    });

    const outcome = await run();
    const rescue = rescueOf(outcome);

    expect(rescue.declare?.arguments).toEqual({
      'x-queue-type': 'classic',
      'x-overflow': 'reject-publish',
    });
    expect(Object.keys(rescue.declare?.arguments ?? {})).toEqual([
      'x-queue-type',
      'x-overflow',
    ]);
    expect(rescue.policyMatches).toEqual({
      user: ['amazon-mq'],
      operator: [],
    });
    expect(rescue.queue).toEqual({
      state: 'will-create',
      declaredType: 'classic',
      classicAssumed: false,
    });
    expect(rescue.headroom).toEqual({
      messages: 1_000,
      bytes: null,
      needMessages: 1,
      needBytes: 16 * 1024 * 1024,
    });
    expect(rescue.failures).toEqual([]);
    expect(rescue.facts).toMatchObject({
      queueName: QUARANTINE,
      queueReady: true,
      overflowSafe: true,
      permissionOk: true,
      alarms: [],
      publishBlocked: false,
    });
    expect(outcome.preflight.rescue).toBe(rescue.facts);
    expect(new Set(api.requests.map((r) => r.method))).toEqual(
      new Set(['GET']),
    );

    const planned = plan(outcome.preflight, { disposition: null });
    expect(isRejection(planned)).toBe(false);
    expect(!isRejection(planned) && planned.preview.disposition).toMatchObject({
      kind: 'quarantine',
      queue: QUARANTINE,
      chosenBy: 'default',
    });
  });

  it('M1-13 AC-11 a full quarantine fails the rescue preflight before any message is taken', async () => {
    const { run, api } = setup({
      queues: { [QUARANTINE]: quarantineRow({ messages: 1_000 }) },
      policies: [
        policyRow({ 'max-length': 1_000, overflow: 'reject-publish' }),
      ],
    });

    const outcome = await run();
    const rescue = rescueOf(outcome);

    expect(rescue.failures).toEqual(['headroom']);
    expect(rescue.headroom.messages).toBe(0);
    expect(rescue.facts.overflowSafe).toBe(false);
    expect(rescue.queue.state).toBe('exists');
    expect(rescue.declare).toBeNull();
    const planned = plan(outcome.preflight);
    expect(isRejection(planned) && planned.code).toBe(
      'RESCUE_PREFLIGHT_FAILED',
    );
    expect(reasonsOf(planned)).toEqual(['rescue-overflow-unsafe']);
    expect(api.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('M1-13 AC-12 a matching message-ttl or expires policy makes the quarantine unsafe', async () => {
    for (const [key, code] of [
      ['message-ttl', 'message-ttl'],
      ['expires', 'expires'],
    ] as const) {
      const { run } = setup({ policies: [policyRow({ [key]: 60_000 })] });
      const outcome = await run();
      const rescue = rescueOf(outcome);
      expect(rescue.failures, key).toEqual([code]);
      expect(rescue.facts.overflowSafe, key).toBe(false);
      expect(reasonsOf(plan(outcome.preflight)), key).toEqual([
        'rescue-overflow-unsafe',
      ]);
    }
  });
});
