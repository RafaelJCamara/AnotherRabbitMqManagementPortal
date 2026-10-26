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
  queuePath,
  type ManagementRow,
  type ProfileOptions,
  type VhostDescription,
} from './preflight-fakes.ts';
import { createPeekPreflight, type PreflightOutcome } from './preflight.ts';
import { RESCUE_FAILURES, type RescueRegistry } from './rescue-preflight.ts';

const CID = 'conn-1' as ConnectionId;
const VHOST = '/';
const NOW = 1_800_000_000_000;
const QUARANTINE = 'product.quarantine';
const signal = new AbortController().signal;
const enc = encodeURIComponent(VHOST);

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
const job: PeekPrincipal = { kind: 'job', surface: 'job', unattended: true };

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

  it('M1-13 AC-13 classic disabled on 3.13 makes the quarantine disposition unavailable', async () => {
    const { run } = setup({
      profile: { era: '3.13', classicEnabled: false },
    });

    const outcome = await run();
    const rescue = rescueOf(outcome);

    expect(rescue.queue.state).toBe('unavailable');
    expect(rescue.failures).toEqual(['classic-disabled-no-fallback']);
    expect(rescue.declare).toBeNull();
    expect(rescue.facts.queueReady).toBe(false);
    const planned = plan(outcome.preflight, { era: '3.13' });
    expect(isRejection(planned) && planned.code).toBe(
      'RESCUE_PREFLIGHT_FAILED',
    );
    expect(reasonsOf(planned)).toEqual(['rescue-queue-not-ready']);
    // Asked for no disposition, the planner offers no quarantine either.
    const open = plan(outcome.preflight, { era: '3.13', disposition: null });
    expect(isRejection(open) && open.code).toBe('NO_SAFE_DISPOSITION');
  });

  it('M1-13 AC-14 the quorum fallback follows the registry cell for limit minus1, not the era name', async () => {
    const quorum = {
      'x-queue-type': 'quorum',
      'x-overflow': 'reject-publish',
      'x-delivery-limit': -1,
    };
    for (const era of ['4.0-4.2', '4.3'] as const) {
      const { run } = setup({ profile: { era, classicEnabled: false } });
      const rescue = rescueOf(await run());
      expect(rescue.queue, era).toEqual({
        state: 'will-create',
        declaredType: 'quorum-unlimited',
        classicAssumed: false,
      });
      expect(rescue.declare?.arguments, era).toEqual(quorum);
      expect(rescue.failures, era).toEqual([]);

      // The same input against a registry in which that cell destroys the message.
      const destructive: RescueRegistry = {
        effectiveConfig: semanticsRegistry.effectiveConfig,
        cell: (key) => {
          const cell = semanticsRegistry.cell(key);
          return key.limit === 'minus1' && cell.effect !== null
            ? { ...cell, effect: { ...cell.effect, destructive: true } }
            : cell;
        },
      };
      const refused = setup({
        profile: { era, classicEnabled: false },
        registry: destructive,
      });
      const unavailable = rescueOf(await refused.run());
      expect(unavailable.queue.state, era).toBe('unavailable');
      expect(unavailable.failures, era).toEqual([
        'classic-disabled-no-fallback',
      ]);
    }
  });

  it('M1-13 AC-15 an unknown classic availability is assumed available and reported as assumed', async () => {
    const assumed = rescueOf(
      await setup({ profile: { classicEnabled: 'unknown' } }).run(),
    );
    expect(assumed.queue).toEqual({
      state: 'will-create',
      declaredType: 'classic',
      classicAssumed: true,
    });
    expect(assumed.declare?.arguments['x-queue-type']).toBe('classic');

    const proven = rescueOf(
      await setup({
        profile: { classicEnabled: 'unknown' },
        queues: { [QUARANTINE]: quarantineRow() },
      }).run(),
    );
    expect(proven.queue).toEqual({
      state: 'exists',
      declaredType: 'classic',
      classicAssumed: false,
    });
    expect(proven.declare).toBeNull();
  });

  it('M1-13 AC-16 an existing queue of the wrong shape is never reused or changed', async () => {
    const wrong: Record<string, ManagementRow> = {
      'not durable': quarantineRow({ durable: false }),
      'drop-head': quarantineRow({
        arguments: { 'x-queue-type': 'classic', 'x-overflow': 'drop-head' },
      }),
      'max-length': quarantineRow({
        arguments: {
          'x-queue-type': 'classic',
          'x-overflow': 'reject-publish',
          'x-max-length': 10,
        },
      }),
      'message-ttl': quarantineRow({
        arguments: {
          'x-queue-type': 'classic',
          'x-overflow': 'reject-publish',
          'x-message-ttl': 1_000,
        },
      }),
      stream: quarantineRow({
        type: 'stream',
        arguments: { 'x-queue-type': 'stream' },
      }),
    };
    for (const [label, row] of Object.entries(wrong)) {
      const { run, api } = setup({ queues: { [QUARANTINE]: row } });
      const rescue = rescueOf(await run());
      expect(rescue.queue.state, label).toBe('unavailable');
      expect(rescue.failures, label).toEqual(['queue-wrong-shape']);
      expect(rescue.facts.queueReady, label).toBe(false);
      expect(rescue.declare, label).toBeNull();
      expect(
        api.requests.every((r) => r.method === 'GET'),
        label,
      ).toBe(true);
    }
  });

  it('M1-13 AC-17 the permission check fails closed and asks configure only when it must declare', async () => {
    const noConfigure = { configure: '^other\\.', write: '.*', read: '.*' };
    const absent = rescueOf(await setup({ permission: noConfigure }).run());
    expect(absent.facts.permissionOk).toBe(false);
    expect(absent.failures).toEqual(['permission-configure']);

    const present = rescueOf(
      await setup({
        permission: noConfigure,
        queues: { [QUARANTINE]: quarantineRow() },
      }).run(),
    );
    expect(present.facts.permissionOk).toBe(true);
    expect(present.failures).toEqual([]);

    // A pattern outside the subset the evaluator decides is never read as a grant.
    const undecided = rescueOf(
      await setup({
        permission: { configure: '.*', write: '(a+)+$', read: '.*' },
      }).run(),
    );
    expect(undecided.facts.permissionOk).toBe(false);
    expect(undecided.failures).toEqual(['permission-undecided']);

    const noWrite = rescueOf(
      await setup({
        permission: { configure: '.*', write: '^other', read: '.*' },
      }).run(),
    );
    expect(noWrite.facts.permissionOk).toBe(false);
    expect(noWrite.failures).toEqual(['permission-write']);
  });

  it('M1-13 AC-18 an alarm, or an alarm state that cannot be read, fails the rescue preflight', async () => {
    const cases: [string, Scenario, readonly string[]][] = [
      [
        'memory',
        {
          nodes: [
            { name: 'rabbit@a', mem_alarm: true, disk_free_alarm: false },
          ],
        },
        ['memory:rabbit@a'],
      ],
      [
        'disk',
        {
          nodes: [
            { name: 'rabbit@b', mem_alarm: false, disk_free_alarm: true },
          ],
        },
        ['disk:rabbit@b'],
      ],
      ['unreadable', { failures: { '/api/nodes': 500 } }, ['alarm-unreadable']],
    ];
    for (const [label, scenario, alarms] of cases) {
      const outcome = await setup(scenario).run();
      expect(outcome.preflight.rescue?.alarms, label).toEqual(alarms);
      const planned = plan(outcome.preflight);
      expect(isRejection(planned) && planned.code, label).toBe(
        'RESCUE_PREFLIGHT_FAILED',
      );
      expect(reasonsOf(planned), label).toContain('rescue-alarm');
    }
  });

  it('M1-13 AC-19 a blocked publish connection stops the plan and an unreadable list is reported', async () => {
    const mine = (state: string) => ({
      name: '10.0.0.1:5672 -> 10.0.0.2:5672',
      state,
      client_properties: { connection_name: 'product/web/peek/ada' },
    });
    const blocked = await setup({ connections: [mine('blocked')] }).run();
    expect(rescueOf(blocked).facts.publishBlocked).toBe(true);
    expect(rescueOf(blocked).failures).toEqual(['publish-blocked']);
    const planned = plan(blocked.preflight);
    expect(isRejection(planned) && planned.code).toBe(
      'RESCUE_PREFLIGHT_FAILED',
    );
    expect(reasonsOf(planned)).toEqual(['rescue-publish-blocked']);

    const unlisted = await setup({
      failures: { [`/api/vhosts/${enc}/connections`]: 403 },
    }).run();
    const rescue = rescueOf(unlisted);
    expect(rescue.facts.publishBlocked).toBe(false);
    expect(rescue.checks.connections).toBe('unreadable');
    expect(rescue.failures).toEqual([]);
  });

  it('M1-13 AC-20 checkedAt is taken after the reads and a repeat call reads again', async () => {
    const holder: { clock?: ReturnType<typeof createManualClock> } = {};
    const { run, api, clock } = setup({
      onRequest: () => holder.clock?.advance(5),
    });
    holder.clock = clock;

    const first = await run();
    const reads = api.requests.length;
    expect(first.preflight.rescue?.checkedAt).toBe(NOW + 5 * reads);
    expect(first.preflight.rescue?.checkedAt).toBe(first.preflight.takenAt);

    clock.advance(61_000);
    const second = await run();
    expect(api.requests.length).toBe(reads * 2);
    expect(second.preflight.rescue?.checkedAt).toBe(clock.now());

    // An unattended run accepts a check of the last minute and refuses an older one (A-1).
    const now = clock.now();
    const stale = plan(first.preflight, { principal: job, nowMs: now });
    expect(reasonsOf(stale)).toContain('rescue-stale');
    const fresh = plan(second.preflight, { principal: job, nowMs: now });
    expect(reasonsOf(fresh)).not.toContain('rescue-stale');
  });

  it("M1-13 AC-21 the outcome carries closed codes only and none of the broker's free text", async () => {
    const { run } = setup({
      policies: [
        policyRow({ 'max-length': 1_000, canary: 'canary-policy-value' }),
      ],
      nodes: [
        {
          name: 'rabbit@a',
          mem_alarm: true,
          disk_free_alarm: false,
          alarm_reason: 'canary-alarm-reason',
        },
      ],
      connections: [
        {
          name: 'x',
          state: 'running',
          client_properties: {
            connection_name: 'product/web/peek',
            canary: 'canary-client',
          },
        },
      ],
      permission: {
        configure: '^product\\.',
        write: '.*',
        read: 'canary-read',
      },
    });

    const outcome = await run();

    expect(JSON.stringify(outcome)).not.toContain('canary');
    const rescue = rescueOf(outcome);
    const closed: readonly string[] = RESCUE_FAILURES;
    expect(rescue.failures).toEqual(['alarm']);
    for (const failure of rescue.failures) expect(closed).toContain(failure);
    expect(rescue.facts.alarms).toEqual(['memory:rabbit@a']);
  });
});

describe('rescue preflight judgement', () => {
  const quorumQuarantine = (overrides: ManagementRow = {}) =>
    quarantineRow({
      type: 'quorum',
      arguments: {
        'x-queue-type': 'quorum',
        'x-overflow': 'reject-publish',
        'x-delivery-limit': -1,
      },
      ...overrides,
    });
  const quarantineAt = (row: ManagementRow) => ({ [QUARANTINE]: row });

  it('the queue state follows the shape found, the profile and the registry cell', async () => {
    const cases: [string, Scenario, string, string, readonly string[]][] = [
      [
        'a classic queue found while classic is said to be off',
        {
          profile: { classicEnabled: false },
          queues: quarantineAt(quarantineRow()),
        },
        'exists',
        'classic',
        [],
      ],
      [
        'the fallback found where -1 keeps the message',
        { profile: { era: '4.3' }, queues: quarantineAt(quorumQuarantine()) },
        'exists',
        'quorum-unlimited',
        [],
      ],
      [
        'the fallback found where -1 destroys the message',
        { profile: { era: '3.13' }, queues: quarantineAt(quorumQuarantine()) },
        'unavailable',
        'classic',
        ['queue-wrong-shape'],
      ],
      [
        'a queue the user may not read',
        { failures: { [queuePath(VHOST, QUARANTINE)]: 403 } },
        'unavailable',
        'classic',
        ['queue-unreadable'],
      ],
      [
        'an era the registry has no cell for',
        { profile: { era: '4.4', classicEnabled: false } },
        'unavailable',
        'classic',
        ['classic-disabled-no-fallback'],
      ],
    ];
    for (const [label, scenario, state, type, failures] of cases) {
      const rescue = rescueOf(await setup(scenario).run());
      expect(rescue.queue.state, label).toBe(state);
      expect(rescue.queue.declaredType, label).toBe(type);
      expect(rescue.failures, label).toEqual(failures);
      expect(rescue.facts.queueReady, label).toBe(state !== 'unavailable');
      expect(rescue.declare === null, label).toBe(state !== 'will-create');
    }
    const unreadable = rescueOf(
      await setup({ failures: { [queuePath(VHOST, QUARANTINE)]: 403 } }).run(),
    );
    expect(unreadable.checks.quarantine).toBe('unreadable');
    // Nothing is judged about a queue that will not be used.
    expect(unreadable.facts.overflowSafe).toBe(true);
    expect(unreadable.policyMatches).toEqual({ user: [], operator: [] });
    const skipped = await setup().run('skip');
    expect(skipped.rescue).toBeNull();
    expect(skipped.preflight.rescue).toBeUndefined();
  });

  it('what a policy does to the quarantine is decided by the registry rules or not at all', async () => {
    const policy = (definition: Record<string, unknown>) => [
      policyRow(definition),
    ];
    const failed = async (scenario: Scenario) => {
      const rescue = rescueOf(await setup(scenario).run());
      return { failures: rescue.failures, safe: rescue.facts.overflowSafe };
    };
    // A classic queue keeps the overflow it was declared with; a quorum queue obeys the policy.
    expect(
      await failed({ policies: policy({ overflow: 'drop-head' }) }),
    ).toEqual({ failures: [], safe: true });
    expect(
      await failed({
        profile: { era: '4.3', classicEnabled: false },
        policies: policy({ overflow: 'drop-head' }),
      }),
    ).toEqual({ failures: ['overflow'], safe: false });
    // An unreadable version, or two policies that tie, decide nothing.
    expect(
      await failed({ profile: { version: null }, policies: policy({}) }),
    ).toEqual({ failures: ['policy-undecided'], safe: false });
    const tie = [
      policyRow({ 'max-length': 500 }, { name: 'a' }),
      policyRow({ 'max-length': 900 }, { name: 'b' }),
    ];
    expect(await failed({ policies: tie })).toEqual({
      failures: ['policy-undecided'],
      safe: false,
    });
    expect(
      await failed({ policies: policy({ 'max-length': 'many' }) }),
    ).toEqual({ failures: ['policy-undecided'], safe: false });
    // An unreadable list is not "no policy", whichever layer it is.
    for (const path of [
      `/api/policies/${enc}`,
      `/api/operator-policies/${enc}`,
    ]) {
      const rescue = rescueOf(await setup({ failures: { [path]: 500 } }).run());
      expect(rescue.failures, path).toEqual(['policies-unreadable']);
      expect(rescue.facts.overflowSafe, path).toBe(false);
      expect(rescue.headroom.messages, path).toBeNull();
    }
    const layered = rescueOf(
      await setup({
        policies: [policyRow({}, { name: 'user-p', pattern: '^product\\.' })],
        operatorPolicies: [
          policyRow({}, { name: 'op-p' }),
          policyRow({}, { name: 'other', pattern: '^zzz' }),
        ],
      }).run(),
    );
    expect(layered.policyMatches).toEqual({
      user: ['user-p'],
      operator: ['op-p'],
    });
  });

  it('the headroom is what is left under the effective limits, and an unread count is no room', async () => {
    const MIB = 1024 * 1024;
    const room = async (
      definition: Record<string, unknown>,
      row: ManagementRow,
      profile: ProfileOptions = {},
    ) => {
      const rescue = rescueOf(
        await setup({
          profile,
          policies: [policyRow(definition)],
          queues: quarantineAt(row),
        }).run(),
      );
      return [rescue.headroom, rescue.failures] as const;
    };
    const [bytes, bytesFailures] = await room(
      { 'max-length-bytes': 20 * MIB },
      quarantineRow({ message_bytes: 5 * MIB }),
    );
    expect(bytes).toEqual({
      messages: null,
      bytes: 15 * MIB,
      needMessages: 1,
      needBytes: 16 * MIB,
    });
    expect(bytesFailures).toEqual(['headroom']);
    // A larger broker limit raises the room a rescue needs.
    const [raised, raisedFailures] = await room(
      { 'max-length-bytes': 100 * MIB },
      quarantineRow({ message_bytes: 5 * MIB }),
      { maxMessageBytes: 128 * MIB },
    );
    expect(raised.needBytes).toBe(128 * MIB);
    expect(raisedFailures).toEqual(['headroom']);
    const [enough, enoughFailures] = await room(
      { 'max-length': 2, 'max-length-bytes': 100 * MIB },
      quarantineRow({ messages: 1, message_bytes: 5 * MIB }),
      { maxMessageBytes: 1024 },
    );
    expect(enough).toMatchObject({
      messages: 1,
      bytes: 95 * MIB,
      needBytes: 16 * MIB,
    });
    expect(enoughFailures).toEqual([]);
    // Exactly the room a rescue needs is enough.
    const [exact, exactFailures] = await room(
      { 'max-length-bytes': 20 * MIB },
      quarantineRow({ message_bytes: 4 * MIB }),
    );
    expect(exact.bytes).toBe(16 * MIB);
    expect(exactFailures).toEqual([]);
    // No count read: the queue is as full as its limit.
    const [unread, unreadFailures] = await room(
      { 'max-length': 50 },
      { ...quarantineRow(), messages: undefined },
    );
    expect(unread.messages).toBe(0);
    expect(unreadFailures).toEqual(['headroom']);
    // A queue not yet declared is empty.
    const fresh = rescueOf(
      await setup({
        policies: [
          policyRow({ 'max-length': 3, 'max-length-bytes': 20 * MIB }),
        ],
      }).run(),
    );
    expect(fresh.headroom).toMatchObject({ messages: 3, bytes: 20 * MIB });
    expect(fresh.failures).toEqual([]);
  });

  it('a permission pattern is never read as a grant unless it is decided to allow both names', async () => {
    const failures = async (permission: ManagementRow) =>
      rescueOf(await setup({ permission }).run()).failures;
    const open = { configure: '.*', read: '' };
    expect(await failures({ ...open, write: '' })).toEqual([
      'permission-undecided',
    ]);
    expect(await failures({ configure: '', write: '.*', read: '' })).toEqual([
      'permission-undecided',
    ]);
    // Allowed for the empty name only, so a publish to the default exchange may be refused.
    expect(await failures({ ...open, write: '^$' })).toEqual([
      'permission-write',
    ]);
    expect(await failures({ ...open, write: '^amq\\.default$' })).toEqual([
      'permission-write',
    ]);
    expect(await failures({ ...open, write: '^(|amq\\.default)$' })).toEqual(
      [],
    );
    const none = rescueOf(await setup({ user: 'nobody' }).run());
    expect(none.failures).toEqual(['permission-undecided']);
    expect(none.checks.permission).toBe('unreadable');
  });

  it('alarms are listed by a fixed code and bounded, and a node that does not say counts as unread', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      name: `n${String(i)}`,
      mem_alarm: true,
      disk_free_alarm: false,
    }));
    const flooded = rescueOf(await setup({ nodes: many }).run());
    expect(flooded.facts.alarms).toHaveLength(32);
    expect(flooded.facts.alarms[0]).toBe('memory:n0');
    expect(flooded.checks.alarmsOmitted).toBe(8);
    const quiet = rescueOf(await setup({}).run());
    expect(quiet.checks.alarmsOmitted).toBe(0);
    expect(quiet.facts.alarms).toEqual([]);

    const long = rescueOf(
      await setup({
        nodes: [
          { name: 'x'.repeat(300), mem_alarm: true, disk_free_alarm: true },
        ],
      }).run(),
    );
    expect(long.facts.alarms).toEqual([
      `memory:${'x'.repeat(128)}`,
      `disk:${'x'.repeat(128)}`,
    ]);

    for (const nodes of [
      [{ name: 'a', mem_alarm: false }],
      [{ name: 'a', disk_free_alarm: false }],
      [{ name: 'a', mem_alarm: null, disk_free_alarm: null }],
      [],
    ]) {
      const label = JSON.stringify(nodes);
      const rescue = rescueOf(await setup({ nodes }).run());
      expect(rescue.facts.alarms, label).toEqual(['alarm-unreadable']);
      expect(rescue.failures, label).toEqual(['alarm-unreadable']);
    }
    const both = rescueOf(
      await setup({
        nodes: [
          { name: 'a', mem_alarm: true, disk_free_alarm: false },
          { name: 'b', mem_alarm: false },
        ],
      }).run(),
    );
    expect(both.facts.alarms).toEqual(['alarm-unreadable', 'memory:a']);
    expect(both.failures).toEqual(['alarm', 'alarm-unreadable']);
  });

  it('only a blocked connection of ours blocks publishing', async () => {
    const connection = (
      state: string,
      names: { name?: string; connection_name?: string },
    ) => ({
      name: names.name ?? '10.0.0.1:1 -> 10.0.0.2:5672',
      state,
      client_properties: {
        connection_name: names.connection_name ?? 'someone-else',
      },
    });
    const blocked = async (...connections: unknown[]) =>
      rescueOf(await setup({ connections }).run()).facts.publishBlocked;
    const named = { connection_name: 'product/web/peek' };
    expect(await blocked(connection('blocked', named))).toBe(true);
    expect(await blocked(connection('blocking', named))).toBe(true);
    expect(await blocked(connection('blocked', { name: 'product/web' }))).toBe(
      true,
    );
    expect(await blocked(connection('running', named))).toBe(false);
    expect(
      await blocked(connection('blocked', { connection_name: 'other/web' })),
    ).toBe(false);
    expect(
      await blocked(
        connection('blocked', { connection_name: 'productx/peek' }),
      ),
    ).toBe(false);
    expect(await blocked({ name: 'a' }, { state: 'blocked' })).toBe(false);
    expect(await blocked()).toBe(false);
  });
});
