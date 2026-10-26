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
  queuePath,
  type FakeEvidenceOptions,
  type ManagementRow,
  type VhostDescription,
} from './preflight-fakes.ts';
import {
  createPeekPreflight,
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
  const service = createPeekPreflight({
    mgmt: api.mgmt,
    evidence,
    clock,
    quarantinePrefix: 'product',
    limits,
  });
  const run = (queue = 'orders', rescue: 'check' | 'skip' = 'skip') =>
    service.run(
      {
        connectionId: CID,
        vhost: VHOST,
        queue,
        principal: caller,
        profile: preflightProfile,
        rescue,
      },
      signal,
    );
  return { api, evidence, clock, run };
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
const decidedBy = (layer: 'argument' | 'operator-policy', value: number) => ({
  key: 'delivery-limit',
  argument: 'x-delivery-limit',
  status: 'effective' as const,
  value,
  rule: null,
  mergeRule: null,
  basis: 'source-read' as const,
  provenance: [{ layer, name: layer, value, role: 'deciding' as const }],
  warnings: [],
});

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
      'mgmt' | 'evidence' | 'clock' | 'quarantinePrefix' | 'limits'
    >();
    expectTypeOf<PeekPreflightDeps['mgmt']>().toEqualTypeOf<MgmtReadPort>();
    expectTypeOf<PeekPreflightDeps['mgmt']>().not.toHaveProperty('send');
  });

  it('M1-13 AC-2 the preflight fills every planner field from a stats-on 4.3 quorum queue', async () => {
    const effective = {
      queueType: 'quorum' as const,
      version: '4.3.6',
      entries: { 'delivery-limit': decidedBy('argument', 20) },
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
    const { api, run } = setup({
      queues: { orders: sacRow },
      consumers: others,
      policies: Array.from({ length: 1_001 }, () => policy),
      operatorPolicies: [policy],
      user: 'ada',
      permission: { configure: '.*', write: '.*', read: '.*' },
    });

    const { preflight, reads, cut } = await run('orders', 'check');

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
    }).run('orders', 'check');

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

    const absent = await setup({}).run('orders', 'check');
    expect(absent.reads?.quarantine).toEqual({ state: 'absent' });
    expect(absent.reads?.permission).toEqual({ state: 'unreadable' });
    const refused = await setup({
      failures: { [queuePath(VHOST, 'product.quarantine')]: 403 },
    }).run('orders', 'check');
    expect(refused.reads?.quarantine).toEqual({ state: 'unreadable' });
    const skipped = await setup({}).run('orders', 'skip');
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
