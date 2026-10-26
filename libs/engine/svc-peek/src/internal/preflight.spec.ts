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
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  createFakeEvidence,
  createScriptedManagement,
  queuePath,
  type FakeEvidenceOptions,
  type ManagementRow,
  type VhostDescription,
} from './preflight-fakes.ts';
import { createPeekPreflight, type PeekPreflightDeps } from './preflight.ts';

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
const sacArguments = {
  'x-queue-type': 'quorum',
  'x-single-active-consumer': true,
};
const sacRow: ManagementRow = { ...quorumRow, arguments: sacArguments };

function setup(
  vhost: Partial<VhostDescription> = {},
  evidenceOptions: FakeEvidenceOptions = {},
) {
  const clock = createManualClock(NOW);
  const api = createScriptedManagement({
    vhost: VHOST,
    ...vhost,
    queues: { orders: quorumRow, ...vhost.queues },
  });
  const evidence = createFakeEvidence(evidenceOptions);
  const service = createPeekPreflight({ mgmt: api.mgmt, evidence, clock });
  const run = (queue = 'orders') =>
    service.run(
      { connectionId: CID, vhost: VHOST, queue, principal: caller },
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
    expectTypeOf<keyof PeekPreflightDeps>().toEqualTypeOf<
      'mgmt' | 'evidence' | 'clock' | 'limits'
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
    const cut = await setup({}, { dlxSources: { sourcesMore: 3 } }).run();
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
});
