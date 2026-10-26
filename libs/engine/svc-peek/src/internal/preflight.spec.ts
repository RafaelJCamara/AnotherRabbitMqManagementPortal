import { ConnectionIdSchema, encodeObjectKey } from '@app/contracts';
import type { ConnectionId } from '@app/contracts';
import { AppError, createManualClock } from '@app/kernel';
import {
  isRejection,
  planPeek,
  type PeekPreflight,
  type PeekPrincipal,
  type PeekProfile,
} from '@app/peek-planner';
import type { MgmtReadPort, Principal } from '@app/ports';
import { semanticsRegistry } from '@app/semantics';
import fc from 'fast-check';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  createFakeEvidence,
  createScriptedManagement,
  effectiveConfigAnswer,
  queuePath,
  type FakeEvidenceOptions,
  type ManagementRow,
  type VhostDescription,
} from './preflight-fakes.ts';
import { QueueRowSchema } from './preflight-rows.ts';
import {
  createPeekPreflight,
  createPreflightGatherer,
  DEFAULT_PREFLIGHT_LIMITS,
  queueFromRow,
  type PeekPreflightDeps,
  type PreflightLimits,
  type PreflightProfile,
} from './preflight.ts';

const CID = 'conn-1' as ConnectionId;
const VHOST = '/';
const NOW = 1_800_000_000_000;
const signal = new AbortController().signal;
const consumersPath = `/api/consumers/${encodeURIComponent(VHOST)}`;

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
const profile: PeekProfile = {
  era: { value: '4.3', reasons: [], conservative: false },
  verification: 'verified',
  versions: { min: null, perNode: {}, mixed: false, build: 'oss' },
  identity: {
    user: 'ada',
    tags: [],
    isAdmin: false,
    canMonitor: true,
    isPolicymaker: false,
  },
  managedObjects: [],
  gates: {},
};

const quorumRow: ManagementRow = {
  name: 'orders',
  vhost: VHOST,
  type: 'quorum',
  durable: true,
  auto_delete: false,
  exclusive: null,
  arguments: {
    'x-queue-type': 'quorum',
    'x-delivery-limit': 20,
    'x-message-ttl': 60_000,
    'x-consumer-timeout': 900_000,
  },
  consumers: 1,
  messages_ready: 40,
  message_bytes_ready: 40_000,
  policy: null,
  operator_policy: null,
  effective_policy_definition: {},
  delivery_limit: 20,
  delayed_retry: 'disabled',
  leader: 'rabbit@a',
  members: ['rabbit@a'],
  online: ['rabbit@a'],
};
const preflightProfile: PreflightProfile = {
  ...profile,
  classicEnabled: 'unknown',
  limits: { preAuthFrameMax: 4096 },
};
const sacArguments = {
  'x-queue-type': 'quorum',
  'x-single-active-consumer': true,
};
const sacRow: ManagementRow = { ...quorumRow, arguments: sacArguments };

function setup(
  vhost: Partial<VhostDescription> = {},
  evidenceOptions: FakeEvidenceOptions = {},
  limits: Partial<PreflightLimits> = {},
) {
  const clock = createManualClock(NOW);
  const api = createScriptedManagement({
    vhost: VHOST,
    ...vhost,
    queues: { orders: quorumRow, ...vhost.queues },
  });
  const evidence = createFakeEvidence(evidenceOptions);
  const deps = {
    mgmt: api.mgmt,
    evidence,
    clock,
    quarantinePrefix: 'product',
    limits,
  };
  const service = createPeekPreflight(deps);
  const gatherer = createPreflightGatherer(deps);
  const asked = (queue: string, rescue: 'check' | 'skip') => ({
    connectionId: CID,
    vhost: VHOST,
    queue,
    principal: caller,
    profile: preflightProfile,
    rescue,
  });
  const run = (queue = 'orders', rescue: 'check' | 'skip' = 'skip') =>
    service.run(asked(queue, rescue), signal);
  // The raw reads, which an outcome never carries (the rescue preflight judges them).
  const gather = (queue = 'orders', rescue: 'check' | 'skip' = 'skip') =>
    gatherer.gather(asked(queue, rescue), signal);
  return { api, evidence, clock, run, gather };
}

/** The real planner over a preflight: a person consents to the broker handling the return. */
function plan(preflight: PeekPreflight, principal: PeekPrincipal = human) {
  const disposition = {
    kind: 'let-broker-handle',
    typedConsent: 'orders',
  } as const;
  return planPeek(
    {
      connectionId: ConnectionIdSchema.parse('lab'),
      queue: encodeObjectKey(VHOST, 'orders'),
      count: 5,
      disposition,
    },
    {
      profile,
      preflight,
      principal,
      registry: semanticsRegistry,
      env: 'dev',
      nowMs: NOW,
    },
  );
}

/** A `queues.effective-config` entry as the topology service answers it. */
const entryOf = (
  key: string,
  status: 'effective' | 'default' | 'unset' | 'unknown' | 'invalid',
  value: number | string | null,
  layer: 'argument' | 'user-policy' | 'operator-policy' = 'argument',
) => ({
  key,
  argument: `x-${key}`,
  status,
  value,
  rule: null,
  mergeRule: null,
  basis: 'source-read' as const,
  provenance: [{ layer, name: layer, value, role: 'deciding' as const }],
  warnings: [],
});
const configOf = (entries: Record<string, ReturnType<typeof entryOf>>) =>
  effectiveConfigAnswer(
    { connectionId: CID, vhost: VHOST, queue: 'q' },
    {
      queueType: 'quorum',
      effective: {
        queueType: 'quorum',
        version: '4.3.6',
        entries,
        mergedPolicy: { notEffective: true, entries: {} },
        unrecognisedArguments: [],
        warnings: [],
      },
    },
  );

describe('peek preflight', () => {
  it('M1-13 AC-1 the preflight issues only GETs on the interactive lane and reaches no write port or lease', async () => {
    const { api, run } = setup({ queues: { orders: sacRow } });

    await run();

    const seen = api.requests.map((r) => [r.method, r.lane, r.path]);
    expect(seen).toEqual([
      ['GET', 'interactive', queuePath(VHOST, 'orders')],
      ['GET', 'interactive', consumersPath],
    ]);
    // The deps name a read port and an evidence port: no write port, no lease, no connection manager.
    // With the rescue check the closed list grows by the quarantine, policies, nodes, connections
    // and the permission row: still reads, still the interactive lane, at most nine.
    const checked = setup({
      queues: { orders: sacRow },
      user: 'ada',
      permission: { configure: '.*', write: '.*', read: '.*' },
    });
    await checked.run('orders', 'check');
    const enc = encodeURIComponent(VHOST);
    expect(new Set(checked.api.requests.map((r) => r.path))).toEqual(
      new Set([
        queuePath(VHOST, 'orders'),
        queuePath(VHOST, 'product.quarantine'),
        consumersPath,
        `/api/policies/${enc}`,
        `/api/operator-policies/${enc}`,
        '/api/nodes',
        `/api/vhosts/${enc}/connections`,
        `/api/permissions/${enc}/ada`,
      ]),
    );
    expect(checked.api.requests.length).toBeLessThanOrEqual(9);
    expect(new Set(checked.api.requests.map((r) => r.method))).toEqual(
      new Set(['GET']),
    );
    expect(new Set(checked.api.requests.map((r) => r.lane))).toEqual(
      new Set(['interactive']),
    );
    expectTypeOf<keyof PeekPreflightDeps>().toEqualTypeOf<
      'mgmt' | 'evidence' | 'clock' | 'quarantinePrefix' | 'limits' | 'registry'
    >();
    expectTypeOf<PeekPreflightDeps['mgmt']>().toEqualTypeOf<MgmtReadPort>();
    expectTypeOf<PeekPreflightDeps['mgmt']>().not.toHaveProperty('send');
  });

  it('M1-13 AC-2 the preflight fills every planner field from a stats-on 4.3 quorum queue', async () => {
    const effective = {
      queueType: 'quorum' as const,
      version: '4.3.6',
      entries: { 'delivery-limit': entryOf('delivery-limit', 'effective', 20) },
      mergedPolicy: { notEffective: true as const, entries: {} },
      unrecognisedArguments: [],
      warnings: [],
    };
    const { run } = setup(
      {},
      { effectiveConfig: { queueType: 'quorum', effective } },
    );

    const { preflight } = await run();

    expect(preflight.queue).toEqual({
      type: 'quorum',
      exclusiveOwnedByOther: false,
      autoDelete: false,
      deliveryLimit: { kind: 'finite', value: 20 },
      limitState: 'finite',
      limitFixedBy: 'argument',
      visibleLimits: [20],
      singleActiveConsumer: false,
      hasActiveConsumer: true,
      consumers: 1,
      ready: 40,
      quorumOk: true,
      avgBytes: 1000,
      delayedRetry: { type: 'disabled' },
      ttlMs: 60_000,
      consumerTimeoutMs: 900_000,
    });
    expect(preflight.dlxSources).toEqual({
      sources: [],
      complete: true,
      unknownReasons: [],
    });
    const planned = plan(preflight);
    expect(isRejection(planned) && planned.code === 'INVALID_REQUEST').toBe(
      false,
    );
  });

  it('M1-13 AC-3 an unread field stays absent and an unreadable consumer list counts as an active consumer', async () => {
    const statsOff = {
      name: 'orders',
      type: 'quorum',
      arguments: sacArguments,
    };
    const { run } = setup({
      queues: { orders: statsOff },
      failures: { [consumersPath]: 500 },
    });

    const { preflight } = await run();

    expect(preflight.queue.deliveryLimit).toEqual({ kind: 'unknown' });
    expect(preflight.queue.limitState).toBe('finite');
    const keys = Object.keys(preflight.queue);
    expect(keys).not.toContain('ready');
    expect(keys).not.toContain('avgBytes');
    expect(keys).not.toContain('ttlMs');
    expect(keys).not.toContain('quorumOk');
    expect(preflight.queue.singleActiveConsumer).toBe(true);
    expect(preflight.queue.hasActiveConsumer).toBe(true);
  });

  it('M1-13 AC-4 the DLX evidence passes through unchanged and held-death sources stay absent', async () => {
    const source = {
      queue: 'src',
      limit: { kind: 'unknown' as const },
      certainty: 'possible' as const,
      via: [],
      reasons: [],
    };
    const reasons = [
      { code: 'dead-letter-unknown', subject: 'src' },
      { code: 'source-limit-unknown' },
    ] as const;
    const { run, evidence } = setup(
      {},
      {
        dlxSources: {
          complete: false,
          sources: [source],
          unknownReasons: [...reasons],
        },
      },
    );

    const { preflight } = await run();

    expect(preflight.dlxSources).toEqual({
      sources: [{ queue: 'src', limit: { kind: 'unknown' } }],
      complete: false,
      unknownReasons: reasons,
    });
    expect('heldDeathSources' in preflight).toBe(false);
    const asked = evidence.calls.find((c) => c.op === 'dlxSources');
    expect(asked?.request).toEqual({
      connectionId: CID,
      vhost: VHOST,
      queue: 'orders',
    });
    const planned = plan(preflight);
    expect(isRejection(planned) ? null : planned.preview.evidence).toEqual({
      dlx: 'unknown',
      heldDeath: 'not-checked',
    });
    // A list cut at its bound is not complete either: it may hide the source that matters.
    const cut = await setup({}, { dlxSources: { sourcesMore: 1 } }).run();
    expect(cut.preflight.dlxSources.complete).toBe(false);
    expect(cut.preflight.dlxSources.unknownReasons).toEqual([
      { code: 'truncated' },
    ]);
  });

  it('M1-13 AC-5 an evidence failure becomes incomplete evidence, never a hazard-free answer', async () => {
    const { run } = setup({}, { failWith: new AppError('BROKER_UNREACHABLE') });

    const { preflight } = await run();

    expect(preflight.dlxSources).toEqual({
      sources: [],
      complete: false,
      unknownReasons: [{ code: 'evidence-unavailable' }],
    });
    const asPerson = plan(preflight);
    expect(
      isRejection(asPerson) ? null : asPerson.preview.limit.reasons,
    ).toContain('dlx-evidence-unverified');
    const asJob = plan(preflight, job);
    expect(isRejection(asJob) && asJob.code).toBe('NO_SAFE_DISPOSITION');
  });

  it('M1-13 AC-6 a missing, refused or malformed queue is a Problem, not a default', async () => {
    const failed = (vhost: Partial<VhostDescription>, queue?: string) =>
      setup(vhost)
        .run(queue)
        .catch((error: unknown) => error);

    const missing = await failed({}, 'ghost');
    const refused = await failed({
      failures: { [queuePath(VHOST, 'orders')]: 403 },
    });
    const malformed = await failed({ queues: { orders: { name: 5 } } });
    const unknownType = await failed({
      queues: { orders: { name: 'orders', type: 'mqtt' } },
    });

    expect(missing).toMatchObject({ code: 'NOT_FOUND' });
    expect(refused).toMatchObject({ code: 'FORBIDDEN_BROKER' });
    expect(malformed).toMatchObject({ code: 'BROKER_ERROR' });
    expect(unknownType).toMatchObject({ code: 'BROKER_ERROR' });
    expect((malformed as AppError).message).toBe('BROKER_ERROR');
  });

  it('M1-13 AC-7 rttMs is the measured read time with a floor of one millisecond', async () => {
    const timed = (queueMs: number, consumersMs: number) => {
      const holder: { clock?: ReturnType<typeof createManualClock> } = {};
      const onRequest = (r: { path: string }) =>
        holder.clock?.advance(r.path === consumersPath ? consumersMs : queueMs);
      const made = setup({ queues: { orders: sacRow }, onRequest });
      holder.clock = made.clock;
      return made.run();
    };

    const slow = await timed(7, 5);
    const instant = await timed(0, 0);

    expect(slow.preflight.rttMs).toBe(7);
    expect(slow.preflight.takenAt).toBe(NOW + 12);
    expect(instant.preflight.rttMs).toBe(1);
    expect(instant.preflight.takenAt).toBe(NOW);
  });

  it('M1-13 AC-8 reads and rows are bounded and an over-bound list fails closed', async () => {
    const others = Array.from({ length: 1_200 }, () => ({
      queue: { name: 'other' },
      active: true,
    }));
    const policy = {
      name: 'p',
      pattern: '.*',
      'apply-to': 'all',
      priority: 0,
      definition: {},
    };
    const { api, gather } = setup({
      queues: { orders: sacRow },
      consumers: others,
      policies: Array.from({ length: 1_001 }, () => policy),
      operatorPolicies: [policy],
      user: 'ada',
      permission: { configure: '.*', write: '.*', read: '.*' },
    });

    const { preflight, reads, cut } = await gather('orders', 'check');

    expect(api.requests.length).toBeLessThanOrEqual(9);
    // Not one consumer of ours was seen, but the cut rows may hold it: not "no consumer".
    expect(cut).toEqual({
      consumers: 200,
      policies: 1,
      operatorPolicies: 0,
      connections: 0,
    });
    expect(preflight.queue.hasActiveConsumer).toBe(true);
    // A policy list past its bound is unreadable, not "no policy"; the others are still read.
    expect(reads?.policies).toEqual({ state: 'unreadable' });
    expect(reads?.operatorPolicies.state).toBe('read');

    const spent = setup({ queues: { orders: sacRow } }, {}, { maxReads: 1 });
    await expect(spent.run()).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(spent.api.requests).toHaveLength(1);
  });

  it('M1-13 AC-9 whatever the broker answers, the preflight output is a valid planner input', async () => {
    const number = fc.oneof(
      fc.constantFrom(-1, 0, 1e308, Number.MAX_SAFE_INTEGER),
      fc.integer({ min: -1_000, max: 1_000_000 }),
      fc.double({ noNaN: true, noDefaultInfinity: true }),
    );
    const value = fc.oneof(
      number,
      fc.string(),
      fc.constant(null),
      fc.boolean(),
      fc.constant({ a: [1] }),
    );
    const row = fc.record(
      {
        name: fc.constant('orders'),
        type: fc.constantFrom('classic', 'quorum', 'stream', 'mqtt'),
        exclusive: fc.option(fc.boolean()),
        consumers: number,
        messages_ready: number,
        message_bytes_ready: number,
        delivery_limit: fc.oneof(
          number,
          fc.constantFrom('unlimited', '20', 'x', '1e999'),
        ),
        delayed_retry: fc.oneof(
          fc.constantFrom('disabled', 'all', 'failed', 'returned'),
          fc.string(),
        ),
        members: fc.array(fc.string(), { maxLength: 5 }),
        online: fc.array(fc.string(), { maxLength: 5 }),
        leader: fc.option(fc.string()),
        arguments: fc.record(
          {
            'x-message-ttl': value,
            'x-max-length': value,
            'x-consumer-timeout': value,
            'x-delivery-limit': value,
            'x-overflow': value,
            'x-single-active-consumer': value,
          },
          { requiredKeys: [] },
        ),
      },
      { requiredKeys: ['name'] },
    );
    const finiteEverywhere = (x: unknown): boolean =>
      typeof x === 'number'
        ? Number.isFinite(x)
        : typeof x === 'object' && x !== null
          ? Object.values(x).every(finiteEverywhere)
          : true;
    let planned = 0;

    await fc.assert(
      fc.asyncProperty(row, async (generated) => {
        const { run } = setup({ queues: { orders: generated } });
        const outcome = await run().then(
          (done) => done,
          (error: unknown) => {
            expect(error).toBeInstanceOf(AppError);
            return null;
          },
        );
        if (outcome === null) return;
        planned += 1;
        expect(finiteEverywhere(outcome.preflight)).toBe(true);
        const result = plan(outcome.preflight);
        if (isRejection(result)) {
          expect(result.reasons).not.toContain('preflight-number-invalid');
        }
      }),
      { numRuns: 300 },
    );
    expect(planned).toBeGreaterThan(50);
  });

  it('the rescue reads are data: the quarantine queue, policies, alarms, connections and the permission', async () => {
    const conforming = {
      name: 'product.quarantine',
      type: 'classic',
      durable: true,
      auto_delete: false,
      exclusive: false,
      arguments: { 'x-queue-type': 'classic', 'x-overflow': 'reject-publish' },
      messages: 3,
      message_bytes: 300,
    };
    const policy = {
      name: 'p',
      pattern: '.*',
      'apply-to': 'all',
      priority: 1,
      definition: { 'max-length': 1_000 },
    };
    const failures = {
      [`/api/operator-policies/${encodeURIComponent(VHOST)}`]: 405,
    };
    const first = await setup({
      queues: { 'product.quarantine': conforming },
      policies: [policy],
      failures,
      nodes: [
        {
          name: 'rabbit@a',
          mem_alarm: true,
          disk_free_alarm: false,
          os_pid: 'x',
        },
      ],
      connections: [
        {
          name: '10.0.0.1:5672',
          state: 'blocked',
          client_properties: {
            connection_name: 'product/peek',
            secret: 'canary',
          },
          user: 'canary',
        },
      ],
      user: 'ada',
      permission: {
        configure: '^product\\.',
        write: '^product\\.',
        read: '.*',
        canary: 'x',
      },
    }).gather('orders', 'check');

    expect(first.reads).toEqual({
      quarantine: {
        state: 'present',
        found: {
          name: 'product.quarantine',
          vhost: VHOST,
          type: 'classic',
          durable: true,
          autoDelete: false,
          exclusive: false,
          arguments: conforming.arguments,
        },
        messages: 3,
        bytes: 300,
      },
      policies: { state: 'read', value: [policy] },
      operatorPolicies: { state: 'unreadable' },
      nodes: {
        state: 'read',
        value: [{ name: 'rabbit@a', mem_alarm: true, disk_free_alarm: false }],
      },
      connections: {
        state: 'read',
        value: [
          {
            name: '10.0.0.1:5672',
            state: 'blocked',
            client_properties: { connection_name: 'product/peek' },
          },
        ],
      },
      permission: {
        state: 'read',
        value: { configure: '^product\\.', write: '^product\\.' },
      },
    });
    expect(first.quarantineName).toBe('product.quarantine');
    expect(JSON.stringify(first)).not.toContain('canary');

    const absent = await setup({}).gather('orders', 'check');
    expect(absent.reads?.quarantine).toEqual({ state: 'absent' });
    expect(absent.reads?.permission).toEqual({ state: 'unreadable' });
    const refused = await setup({
      failures: { [queuePath(VHOST, 'product.quarantine')]: 403 },
    }).gather('orders', 'check');
    expect(refused.reads?.quarantine).toEqual({ state: 'unreadable' });
    const skipped = await setup({}).gather('orders', 'skip');
    expect(skipped.reads).toBeNull();
    const deps = {
      mgmt: setup().api.mgmt,
      evidence: createFakeEvidence(),
      clock: createManualClock(),
    };
    expect(() =>
      createPeekPreflight({ ...deps, quarantinePrefix: 'RabbitTool' }),
    ).toThrow(RangeError);
  });
});

describe('peek preflight mapping', () => {
  const map = (
    row: Record<string, unknown>,
    entries: Record<string, ReturnType<typeof entryOf>> = {},
    consumers: { seen?: number; active?: boolean } = {},
  ) =>
    queueFromRow(
      QueueRowSchema.parse({ name: 'q', type: 'quorum', ...row }),
      configOf(entries),
      { seen: consumers.seen, active: consumers.active ?? false },
    );

  it('an unlimited quorum limit is unset only when nothing could have set it', () => {
    const bare = {
      delivery_limit: 'unlimited',
      arguments: {},
      policy: null,
      operator_policy: null,
    };

    expect(map(bare)).toMatchObject({
      deliveryLimit: { kind: 'unlimited' },
      limitState: 'unset',
      limitFixedBy: null,
    });
    expect(map({ ...bare, policy: 'p' }).limitState).toBe('minus1');
    expect(map({ ...bare, delivery_limit: -1 }).limitState).toBe('unset');
    expect(
      map({ ...bare, arguments: { 'x-delivery-limit': -1 } }),
    ).toMatchObject({ limitState: 'minus1', limitFixedBy: 'argument' });
    expect(map({ ...bare, operator_policy: 'op' })).toMatchObject({
      limitState: 'minus1',
      limitFixedBy: 'operator-policy',
    });
    expect(
      map(
        { ...bare, policy: 'p' },
        { 'delivery-limit': entryOf('delivery-limit', 'unset', null) },
      ).limitState,
    ).toBe('unset');
    expect(map({ ...bare, arguments: undefined }).limitState).toBe('minus1');
    // The rules name who decides; a user policy can be raised, an unknown fixer cannot be trusted.
    const user = entryOf('delivery-limit', 'effective', 5, 'user-policy');
    expect(
      map({ operator_policy: 'op' }, { 'delivery-limit': user }).limitFixedBy,
    ).toBeNull();
    const operator = entryOf(
      'delivery-limit',
      'effective',
      5,
      'operator-policy',
    );
    expect(map({}, { 'delivery-limit': operator }).limitFixedBy).toBe(
      'operator-policy',
    );
    for (const status of ['unknown', 'invalid'] as const) {
      const unclear = {
        'delivery-limit': entryOf('delivery-limit', status, null),
      };
      expect(map({ operator_policy: 'op' }, unclear).limitFixedBy).toBe(
        'operator-policy',
      );
    }
    expect(
      map(
        { operator_policy: null },
        { 'delivery-limit': entryOf('delivery-limit', 'unknown', null) },
      ).limitFixedBy,
    ).toBeNull();
  });

  it('the delivery-limit stat is finite only for a positive whole number', () => {
    const limit = (delivery_limit: unknown) =>
      map({ delivery_limit }).deliveryLimit;

    expect(limit(1)).toEqual({ kind: 'finite', value: 1 });
    expect(limit('20')).toEqual({ kind: 'finite', value: 20 });
    expect(limit(-1)).toEqual({ kind: 'unlimited' });
    for (const odd of [0, 1.5, 'x', null, undefined, ''])
      expect(limit(odd)).toEqual({ kind: 'unknown' });
    expect(map({ type: 'classic', delivery_limit: 5 })).toMatchObject({
      deliveryLimit: { kind: 'unlimited' },
      limitState: 'unset',
    });
  });

  it('a setting takes the decided value, else the lowest the row shows, and absent stays absent', () => {
    const row = {
      arguments: {
        'x-delivery-limit': 4,
        'x-message-ttl': 1_000,
        'x-max-length': 50,
        'x-consumer-timeout': 0,
        'x-overflow': 'reject-publish-dlx',
      },
      effective_policy_definition: {
        'message-ttl': 700,
        'max-length': 90,
        overflow: 'drop-head',
        'delivery-limit': 9,
      },
    };

    expect(map(row)).toMatchObject({
      ttlMs: 700,
      maxLength: 50,
      consumerTimeoutMs: 0,
      overflow: 'drop-head',
      visibleLimits: [4, 9],
    });
    const decided = {
      'message-ttl': entryOf('message-ttl', 'effective', 500),
      'max-length': entryOf('max-length', 'default', 10),
      'consumer-timeout': entryOf('consumer-timeout', 'effective', 100),
      overflow: entryOf('overflow', 'effective', 'reject-publish'),
      'delivery-limit': entryOf('delivery-limit', 'effective', 3, 'argument'),
    };
    expect(map(row, decided)).toMatchObject({
      ttlMs: 500,
      consumerTimeoutMs: 100,
      maxLength: 10,
      overflow: 'reject-publish',
      visibleLimits: [3, 4, 9],
    });
    // A status without a decision falls back to the row.
    const undecided = {
      'message-ttl': entryOf('message-ttl', 'unknown', null),
    };
    expect(map(row, undecided).ttlMs).toBe(700);
    const keys = Object.keys(
      map({
        arguments: {
          'x-message-ttl': -5,
          'x-max-length': 'x',
          'x-overflow': 'weird',
        },
      }),
    );
    for (const absent of [
      'ttlMs',
      'maxLength',
      'overflow',
      'consumerTimeoutMs',
      'delayedRetry',
      'visibleLimits',
    ]) {
      expect(keys).not.toContain(absent);
    }
    expect(
      map({ arguments: { 'x-overflow': 'reject-publish-dlx' } }).overflow,
    ).toBe('reject-publish-dlx');
  });

  it('delayed retry, quorum health and the queue type come from the sources the broker gives', () => {
    expect(map({ delayed_retry: 'all' }).delayedRetry).toEqual({ type: 'all' });
    expect(
      map({ arguments: { 'x-delayed-retry-type': 'failed' } }).delayedRetry,
    ).toEqual({ type: 'failed' });
    const viaRules = map(
      {},
      {
        'delayed-retry-type': entryOf(
          'delayed-retry-type',
          'effective',
          'returned',
        ),
      },
    );
    expect(viaRules.delayedRetry).toEqual({ type: 'returned' });
    expect(map({ delayed_retry: 'bogus' })).not.toHaveProperty('delayedRetry');
    const health = (leader: string | null, members: number, online: number) =>
      map({
        leader,
        members: Array(members).fill('n'),
        online: Array(online).fill('n'),
      }).quorumOk;
    expect(health('a', 3, 2)).toBe(true);
    expect(health('a', 4, 2)).toBe(false);
    expect(health('a', 4, 3)).toBe(true);
    expect(health('', 3, 3)).toBe(false);
    expect(health(null, 3, 3)).toBe(false);
    expect(
      map({ type: 'classic', leader: 'a', members: ['n'], online: ['n'] }),
    ).not.toHaveProperty('quorumOk');
    expect(
      map({ type: undefined, arguments: { 'x-queue-type': 'classic' } }).type,
    ).toBe('classic');
    expect(() => map({ type: undefined, arguments: {} })).toThrow(AppError);
  });

  it('sizes, owners and consumers are read as the row gives them', () => {
    expect(map({ messages_ready: 2, message_bytes_ready: 10 }).avgBytes).toBe(
      5,
    );
    expect(map({ messages_ready: 1, message_bytes_ready: 7 }).avgBytes).toBe(7);
    expect(
      map({ messages_ready: 0, message_bytes_ready: 10 }),
    ).not.toHaveProperty('avgBytes');
    expect(map({ messages_ready: 3 })).not.toHaveProperty('avgBytes');
    expect(map({ exclusive: true }).exclusiveOwnedByOther).toBe(true);
    expect(map({ exclusive: false }).exclusiveOwnedByOther).toBe(false);
    expect(map({ exclusive: null }).exclusiveOwnedByOther).toBe(false);
    const idle = map({ arguments: {} });
    expect(idle).toMatchObject({
      consumers: 0,
      hasActiveConsumer: false,
      singleActiveConsumer: false,
    });
    expect(map({ arguments: {} }, {}, { seen: 2 })).toMatchObject({
      consumers: 2,
      hasActiveConsumer: true,
    });
    expect(
      map({ arguments: {}, consumers: 1 }, {}, { seen: 2 }).consumers,
    ).toBe(1);
    expect(
      map(
        { arguments: { 'x-single-active-consumer': true }, consumers: 3 },
        {},
        { active: false },
      ).hasActiveConsumer,
    ).toBe(false);
  });

  it('lists are requested with one page of the broker maximum and cut rows are counted', async () => {
    expect(DEFAULT_PREFLIGHT_LIMITS).toEqual({
      maxPolicies: 1_000,
      maxConsumerRows: 1_000,
      maxConnectionRows: 1_000,
      maxReads: 9,
    });
    const plain = setup({
      queues: { orders: sacRow },
      user: 'ada',
      permission: { configure: '', write: '' },
    });
    const done = await plain.gather('orders', 'check');
    const queries = Object.fromEntries(
      plain.api.requests.map((r) => [r.path, r.query]),
    );
    expect(queries[queuePath(VHOST, 'orders')]).toEqual({
      enable_queue_totals: true,
    });
    expect(queries[queuePath(VHOST, 'product.quarantine')]).toEqual({
      enable_queue_totals: true,
    });
    expect(queries[consumersPath]).toEqual({ page_size: 500 });
    expect(queries['/api/nodes']).toEqual({
      columns: 'name,mem_alarm,disk_free_alarm',
      page_size: 500,
    });
    expect(done.cut).toEqual({
      consumers: 0,
      policies: 0,
      operatorPolicies: 0,
      connections: 0,
    });
    expect(done.reads?.nodes).toEqual({ state: 'read', value: [] });
    expect((await setup().gather()).cut).toEqual(done.cut);

    const item = { name: 'c', state: 'running' };
    const cases = [
      [{ items: [item, item], page_count: 1, total_count: 2 }, 0],
      [{ items: [item, item] }, 0],
      [{ items: [] }, 0],
      [{ items: [item], page_count: 2 }, 1],
      [{ items: [item], page_count: 3 }, 1],
      [{ items: [item], total_count: 5 }, 4],
      [{ items: [item], page_count: 1, total_count: 1 }, 0],
    ] as const;
    for (const [connections, cut] of cases) {
      const made = await setup({ connections }).gather('orders', 'check');
      expect(made.cut.connections, JSON.stringify(connections)).toBe(cut);
    }
    const cutNodes = await setup({
      nodes: { items: [{ name: 'a' }], page_count: 2 },
    }).gather('orders', 'check');
    expect(cutNodes.reads?.nodes).toEqual({ state: 'unreadable' });
    const wholeNodes = await setup({
      nodes: { items: [{ name: 'a' }], page_count: 1 },
    }).gather('orders', 'check');
    expect(wholeNodes.reads?.nodes.state).toBe('read');
    const items = Array.from({ length: 1_001 }, () => item);
    expect(
      (await setup({ connections: items }).gather('orders', 'check')).cut
        .connections,
    ).toBe(1);
    const sources = await setup({}, { dlxSources: { sourcesMore: 0 } }).run();
    expect(sources.preflight.dlxSources.complete).toBe(true);
    // Only the consumers of this queue count, and only an active one makes it busy.
    const mine = (active?: boolean) => ({
      queue: { name: 'orders' },
      ...(active === undefined ? {} : { active }),
    });
    const other = { queue: { name: 'other' }, active: true };
    const busy = async (consumers: unknown[]) =>
      (await setup({ queues: { orders: sacRow }, consumers }).run()).preflight
        .queue.hasActiveConsumer;
    expect(await busy([mine(false), other])).toBe(false);
    expect(await busy([mine()])).toBe(true);
    expect(await busy([mine(false), mine(true)])).toBe(true);
    expect(await busy(Array.from({ length: 1_001 }, () => other))).toBe(true);
    expect(await busy([mine(true)])).toBe(true);
    const noType = {
      name: 'product.quarantine',
      arguments: { 'x-queue-type': 'classic' },
    };
    const found = await setup({
      queues: { 'product.quarantine': noType },
    }).gather('orders', 'check');
    expect(found.reads?.quarantine).toMatchObject({
      state: 'present',
      found: { type: 'classic' },
    });
  });

  it('an abort or a shutdown is never turned into a gap', async () => {
    const aborted = new AbortController();
    const idle = setup();
    const service = createPeekPreflight({
      mgmt: idle.api.mgmt,
      evidence: idle.evidence,
      clock: idle.clock,
      quarantinePrefix: 'product',
    });
    aborted.abort();
    const request = {
      connectionId: CID,
      vhost: VHOST,
      queue: 'orders',
      principal: caller,
      profile: preflightProfile,
      rescue: 'skip',
    } as const;
    const outcome = await service
      .run(request, aborted.signal)
      .catch((error: unknown) => error);
    expect(outcome).not.toBeInstanceOf(AppError);

    // An abort that lands during the quarantine read is rethrown, not read as "unreadable".
    const mid = new AbortController();
    const quarantinePath = queuePath(VHOST, 'product.quarantine');
    const during = setup({
      failures: { [quarantinePath]: 500 },
      onRequest: (r) => {
        if (r.path === quarantinePath) mid.abort();
      },
    });
    const midService = createPeekPreflight({
      mgmt: during.api.mgmt,
      evidence: during.evidence,
      clock: during.clock,
      quarantinePrefix: 'product',
    });
    await expect(
      midService.run({ ...request, rescue: 'check' }, mid.signal),
    ).rejects.toMatchObject({ code: 'BROKER_ERROR' });

    const stopping = setup(
      {},
      { failWith: new AppError('ENGINE_SHUTTING_DOWN') },
    );
    await expect(stopping.run()).rejects.toMatchObject({
      code: 'ENGINE_SHUTTING_DOWN',
    });
    const refusing = setup({
      queues: { orders: sacRow },
      failures: { [consumersPath]: 403 },
    });
    expect((await refusing.run()).preflight.queue.hasActiveConsumer).toBe(true);
    const unlisted = await setup({ queues: { orders: sacRow } }).gather(
      'orders',
      'check',
    );
    expect(unlisted.reads?.permission).toEqual({ state: 'unreadable' });
  });

  it('rttMs keeps a fraction of a millisecond above the floor', async () => {
    const holder: { clock?: ReturnType<typeof createManualClock> } = {};
    const made = setup({ onRequest: () => holder.clock?.advance(1.5) });
    holder.clock = made.clock;
    expect((await made.run()).preflight.rttMs).toBe(1.5);
  });
});
