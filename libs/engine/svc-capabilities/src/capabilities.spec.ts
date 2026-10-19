// The acceptance criteria of M0-45 (probe sequence and BrokerProfile). The broker is a fake
// `MgmtReadPort` that replays the golden fixtures (testing/fixtures), never the adapter.
import {
  ConnectionIdSchema,
  PROBE_STEP_IDS,
  probeRun,
  profileGet,
} from '@app/contracts';
import {
  BrokerScheduler,
  createTestContext,
  createTestExecutor,
  createTestPrincipal,
  scheduleMgmtRead,
} from '@app/kernel';
import type { MgmtGetRequest, MgmtReadPort } from '@app/ports';
import { semanticsRegistry } from '@app/semantics';
import { describe, expect, it } from 'vitest';

import { createProbeRunAction } from './actions/probe-run';
import { createProfileGetAction } from './actions/profile-get';
import { fixtureRoutes, type FixtureTarget } from './fixtures';
import { oauthFromBootstrap } from './probe/steps/03-oauth-discovery';
import { runProbe } from './probe/run';
import { buildProfile, UNLISTED_NODES } from './profile-builder';
import {
  brokerError,
  createCapabilitiesFakeDeps,
  createFakeWire,
  createScriptedMgmt,
  type FakeWire,
  type Route,
} from './testing';

const CID = ConnectionIdSchema.parse('c1');

/** Probes a scripted broker and builds the profile, without the action around it. */
async function probe(
  routes: Readonly<Record<string, Route>>,
  options: {
    wire?: FakeWire;
    lastVerified?: readonly string[];
    mgmt?: MgmtReadPort;
    signal?: AbortSignal;
  } = {},
) {
  const scripted = createScriptedMgmt(routes);
  const run = await runProbe({
    connectionId: CID,
    mgmt: options.mgmt ?? scripted.read,
    wire: options.wire ?? createFakeWire(),
    registry: semanticsRegistry,
    signal: options.signal ?? new AbortController().signal,
  });
  const profile = buildProfile({
    connectionId: CID,
    probedAt: 5_000,
    facts: run.facts,
    registry: semanticsRegistry,
    lastVerified: options.lastVerified ?? [],
  });
  return { profile, run, scripted };
}

/** A broker's routes with some answers replaced. */
const broker = (
  target: FixtureTarget,
  changes: Readonly<Record<string, Route>> = {},
  mode?: 'stats-on' | 'stats-off',
) => ({ ...fixtureRoutes(target, mode), ...changes });

const overviewOf = (
  target: FixtureTarget,
  changes: object,
  mode?: 'stats-on' | 'stats-off',
) => ({
  ...(fixtureRoutes(target, mode)['/api/overview'] as object),
  ...changes,
});

/**
 * A cluster whose overview is answered in turn by the `answering` nodes (name to version) and
 * whose node list also names the `silent` nodes, which never answer.
 */
function cluster(
  answering: Readonly<Record<string, string>>,
  silent: readonly string[] = [],
): Record<string, Route> {
  const names = Object.keys(answering);
  return {
    '/api/overview': (call: number) => {
      const node = names[(call - 1) % names.length] ?? '';
      return overviewOf('4.3.6', {
        node,
        rabbitmq_version: answering[node] ?? '',
      });
    },
    '/api/nodes': [...names, ...silent].map((name) => ({
      name,
      running: true,
    })),
  };
}

const RABBIT_VERSIONS = ['3.13.7', '4.0.9', '4.1.8', '4.2.9', '4.3.6'] as const;

describe('AC-1 load balancer detection', () => {
  const answers = ['rabbit@a', 'rabbit@b', 'rabbit@c'];
  const balanced = {
    '/api/overview': (call: number) =>
      overviewOf('4.3.6', { node: answers[(call - 1) % answers.length] }),
    '/api/nodes': answers.map((name) => ({ name, running: true })),
  };

  it('AC-1 repeated /api/overview answers from different nodes give lbFronted=true with evidence, and node-local results are labelled', async () => {
    const { profile } = await probe(broker('4.3.6', balanced));

    expect(profile.lbFronted.value).toBe(true);
    expect(profile.lbFronted.evidence[0]).toContain('3 different nodes');
    expect(profile.lbFronted.evidence[0]).toContain('rabbit@b');
    expect(
      profile.lbFronted.evidence.some((line) =>
        line.startsWith('node-local results'),
      ),
    ).toBe(true);
  });

  it('AC-1 each node that answered gives its own version, so a balanced cluster of one release is not unreadable', async () => {
    const { profile } = await probe(broker('4.3.6', balanced));

    expect(Object.keys(profile.versions.perNode)).toEqual(answers);
    expect(Object.values(profile.versions.perNode).map((v) => v?.raw)).toEqual([
      '4.3.6',
      '4.3.6',
      '4.3.6',
    ]);
    expect(profile.versions.min?.raw).toBe('4.3.6');
    expect(profile.versions.mixed).toBe(false);
  });

  it('AC-1 through the real BrokerScheduler a balanced cluster is still seen: the probe never shares an answer between its reads', async () => {
    const scripted = createScriptedMgmt(broker('4.3.6', balanced));
    const mgmt = scheduleMgmtRead(scripted.read, new BrokerScheduler());

    const { profile } = await probe(broker('4.3.6', balanced), { mgmt });
    const merged = await probe(broker('4.3.6', balanced), { mgmt });

    // Every ask reached the broker, three per probe: the scheduler merges requests that share a
    // schema object, and a second probe must ask again, not be served the first one's answers.
    expect(profile.lbFronted.value).toBe(true);
    expect(merged.profile.lbFronted.value).toBe(true);
    expect(
      scripted.requests.filter((request) => request.path === '/api/overview'),
    ).toHaveLength(6);
  });

  it('AC-1 one node answering every time is not balanced, and says how often it answered', async () => {
    const { profile } = await probe(broker('4.3.6'));

    expect(profile.lbFronted.value).toBe(false);
    expect(profile.lbFronted.evidence).toEqual([
      '/api/overview was answered 3 time(s) by rabbit@lab-node',
    ]);
  });

  it('AC-1 a managed provider is balanced even when three answers came from one node', async () => {
    const wire = createFakeWire();
    wire.target = {
      host: 'b-1234.mq.eu-west-1.amazonaws.com',
      managementTls: true,
    };

    const { profile } = await probe(broker('4.3.6'), { wire });

    expect(profile.provider).toBe('amazon-mq');
    expect(profile.lbFronted.value).toBe(true);
    expect(profile.lbFronted.evidence.join(' ')).toContain('amazon-mq fronts');
  });
});

describe('AC-2 products and read-only probing', () => {
  it('AC-2 LavinMQ fixtures (no rabbitmq_version, extensions []) give product=lavinmq, and every rule reads it cautiously', async () => {
    const { profile, run } = await probe(fixtureRoutes('lavinmq-2.10.2'));

    expect(profile.product).toBe('lavinmq');
    expect(profile.extensions).toEqual([]);
    expect(profile.stats.disabled).toBe(false);
    // 2.10.2 is not a RabbitMQ version, so no node has one and the era is the conservative one.
    expect(Object.values(profile.versions.perNode)).toEqual([null]);
    expect(profile.versions.min).toBeNull();
    expect(profile.era).toMatchObject({ value: '4.0-4.2', conservative: true });
    expect(profile.era.reasons.join(' ')).toContain('not RabbitMQ');
    expect(profile.verification).toBe('unknown-build');
    expect(profile.versions.build).toBe('commercial-or-unknown');
    expect(profile.firehose.available).toBe('none');
    expect(
      semanticsRegistry.capability('channelsAcceptDisableStats', profile),
    ).toBe(false);
    // The broker has no feature-flag endpoint: a normal answer, and the flags stay unknown.
    expect(profile.featureFlags).toEqual({});
    expect(run.steps.find((s) => s.id === 'feature-flags')?.status).toBe(
      'unavailable',
    );
  });

  it('AC-2 any probe run makes zero write-shaped requests (recording fake), on every recorded broker', async () => {
    const targets: [FixtureTarget, 'stats-on' | 'stats-off' | undefined][] = [
      ...RABBIT_VERSIONS.flatMap(
        (version): [FixtureTarget, 'stats-on' | 'stats-off'][] => [
          [version, 'stats-on'],
          [version, 'stats-off'],
        ],
      ),
      ['lavinmq-2.10.2', undefined],
    ];
    for (const [target, mode] of targets) {
      const deps = createCapabilitiesFakeDeps({
        ownerId: 'user-1',
        routes: fixtureRoutes(target, mode),
      });
      const engine = createTestExecutor();
      engine.executor.register(createProbeRunAction(deps));

      const done = await engine.executor.run(
        probeRun,
        { cid: 'c1' },
        createTestContext({ idempotencyKey: `zero-writes-${target}` }),
      );

      expect(done.kind).toBe('output');
      expect(deps.scripted.requests.length).toBeGreaterThan(10);
      // Reads only: every request is a GET, none asks for messages, none carries a statistics flag.
      expect(
        deps.scripted.requests.every(
          (request) =>
            request.method === 'GET' &&
            !request.path.endsWith('/get') &&
            !('disable_stats' in request.query),
        ),
      ).toBe(true);
      // The module is never handed a write port: the read port has no `send`.
      expect('send' in deps).toBe(false);
      expect('send' in deps.mgmt).toBe(false);
      expect(engine.writeCalls).toEqual([]);
    }
  });

  it('AC-2 the twelve steps run in the order of the fact sheet, and each read asks again instead of sharing an answer', async () => {
    const schemas: unknown[] = [];
    const scripted = createScriptedMgmt(fixtureRoutes('4.3.6'));
    const mgmt: MgmtReadPort = {
      get: <T>(request: MgmtGetRequest<T>, signal: AbortSignal) => {
        schemas.push(request.schema);
        return scripted.read.get(request, signal);
      },
      stream: (request, signal) => scripted.read.stream(request, signal),
    };

    const first = await probe(fixtureRoutes('4.3.6'), { mgmt });
    const reads = schemas.length;
    await probe(fixtureRoutes('4.3.6'), { mgmt });

    expect(first.run.steps.map((step) => step.id)).toEqual([...PROBE_STEP_IDS]);
    // The scheduler merges requests that share a schema object: a probe must never be merged, so
    // two runs (and the three overview asks of one) share none.
    expect(new Set(schemas).size).toBe(schemas.length);
    expect(schemas.length).toBe(reads * 2);
  });
});

describe('what the probe reads, per broker version', () => {
  it.each(RABBIT_VERSIONS)(
    'AC-2 RabbitMQ %s (statistics on): product, version of its node, era and verification',
    async (version) => {
      const era =
        version === '3.13.7' ? '3.13' : version === '4.3.6' ? '4.3' : '4.0-4.2';

      const plain = await probe(fixtureRoutes(version));
      const verified = await probe(fixtureRoutes(version), {
        lastVerified: [version],
      });

      expect(plain.profile.product).toBe('rabbitmq');
      expect(plain.profile.versions.perNode['rabbit@lab-node']?.raw).toBe(
        version,
      );
      expect(plain.profile.versions.min?.raw).toBe(version);
      expect(plain.profile.era.value).toBe(era);
      expect(plain.profile.stats).toMatchObject({ disabled: false });
      expect(plain.profile.identity).toMatchObject({
        user: 'guest',
        isAdmin: true,
        canMonitor: true,
      });
      expect(plain.profile.verification).toBe('unverified-minor');
      expect(verified.profile.verification).toBe('verified');
      expect(plain.run.steps.filter((s) => s.status === 'failed')).toEqual([]);
    },
  );

  it('AC-2 RabbitMQ 4.3.6 with statistics off: the overview says so, lists no listeners, and no metrics endpoint is guessed', async () => {
    const { profile } = await probe(fixtureRoutes('4.3.6', 'stats-off'));
    const on = await probe(fixtureRoutes('4.3.6', 'stats-on'));

    expect(profile.stats.disabled).toBe(true);
    // Golden fixtures: no listeners and no plugin list while statistics are off (OQ-431), so there
    // is no evidence of a Prometheus endpoint, and a missing one is better than a wrong one.
    expect(profile.prometheus.endpoints).toEqual([]);
    expect(on.profile.prometheus.endpoints).toEqual([
      {
        node: 'rabbit@lab-node',
        url: 'http://mq.example:15692/metrics',
        source: 'listener',
      },
    ]);
    expect(on.profile.streams).toMatchObject({
      supported: true,
      paths: ['amqp091', 'stream-protocol'],
    });
    // The extension list still shows `stream.js`, so streams are supported, but with no listeners
    // the stream protocol port is not known.
    expect(profile.streams).toMatchObject({
      supported: true,
      paths: ['amqp091'],
    });
  });

  it('AC-2 a missing statistics flag means statistics are off, so the cautious rules apply', async () => {
    const rest: Record<string, unknown> = { ...overviewOf('4.3.6', {}) };
    delete rest.disable_stats;

    const { profile } = await probe(broker('4.3.6', { '/api/overview': rest }));

    expect(profile.stats.disabled).toBe(true);
  });
});

describe('conservative results (fail towards hazards and away from capabilities)', () => {
  it('a node whose version cannot be read is null, and the registry then grants no capability and reports every hazard that might apply', async () => {
    // The API names no per-node version, so a node has one only when it answered the overview.
    const known = await probe(
      broker(
        '4.3.6',
        cluster({ 'rabbit@lab-node': '4.3.6', 'rabbit@other': '4.3.6' }),
      ),
    );
    const unread = await probe(
      broker(
        '4.3.6',
        cluster({ 'rabbit@lab-node': '4.3.6' }, ['rabbit@other']),
      ),
    );

    expect(known.profile.versions.perNode['rabbit@other']?.raw).toBe('4.3.6');
    expect(known.profile.era.value).toBe('4.3');
    expect(
      semanticsRegistry.capability('channelsAcceptDisableStats', known.profile),
    ).toBe(true);

    expect(unread.profile.versions.perNode['rabbit@other']).toBeNull();
    expect(unread.profile.versions.min).toBeNull();
    expect(unread.profile.era).toMatchObject({
      value: '4.0-4.2',
      conservative: true,
    });
    expect(
      semanticsRegistry.capability(
        'channelsAcceptDisableStats',
        unread.profile,
      ),
    ).toBe(false);
    for (const id of known.profile.hazards) {
      expect(unread.profile.hazards).toContain(id);
    }
    expect(unread.profile.hazards.length).toBeGreaterThan(
      known.profile.hazards.length,
    );
  });

  it('a mixed-version cluster keeps the lowest version, is marked mixed, and takes the cautious era', async () => {
    const mixed = await probe(
      broker(
        '4.3.6',
        cluster({ 'rabbit@lab-node': '4.3.6', 'rabbit@old': '4.2.9' }),
      ),
    );
    const old = await probe(fixtureRoutes('4.2.9'));

    expect(mixed.profile.versions.mixed).toBe(true);
    expect(mixed.profile.versions.min?.raw).toBe('4.2.9');
    expect(mixed.profile.era).toMatchObject({
      value: '4.0-4.2',
      conservative: true,
    });
    expect(mixed.profile.era.reasons.join(' ')).toContain('mixed versions');
    expect(
      semanticsRegistry.capability('channelsAcceptDisableStats', mixed.profile),
    ).toBe(false);
    for (const id of old.profile.hazards) {
      expect(mixed.profile.hazards).toContain(id);
    }
  });

  it('an unknown product has no RabbitMQ version, an unknown build and no capability', async () => {
    const { profile } = await probe({
      ...MIN,
      '/api/overview': { node: 'x@y', product_name: 'MysteryMQ' },
    });

    expect(profile.product).toBe('unknown');
    expect(Object.values(profile.versions.perNode)).toEqual([null]);
    expect(profile.versions.build).toBe('commercial-or-unknown');
    expect(profile.verification).toBe('unknown-build');
    expect(profile.era).toMatchObject({ value: '4.0-4.2', conservative: true });
    expect(profile.stats.disabled).toBe(true);
    expect(profile.firehose.available).toBe('none');
    expect(profile.streams.supported).toBe(false);
    expect(
      semanticsRegistry.capability('channelsAcceptDisableStats', profile),
    ).toBe(false);
    // `unknown` is held to the RabbitMQ hazards, not exempted from them.
    expect(profile.hazards.length).toBeGreaterThan(0);
  });

  it('a node list that cannot be read leaves nodes nobody has looked at: an unreadable entry, and the same cautious result', async () => {
    const { profile, run } = await probe(
      broker('4.3.6', { '/api/nodes': brokerError(403) }),
    );

    expect(run.steps.find((s) => s.id === 'nodes')).toMatchObject({
      status: 'unavailable',
    });
    expect(profile.versions.perNode[UNLISTED_NODES]).toBeNull();
    expect(profile.versions.min).toBeNull();
    expect(profile.era).toMatchObject({ value: '4.0-4.2', conservative: true });
    expect(
      semanticsRegistry.capability('channelsAcceptDisableStats', profile),
    ).toBe(false);
  });

  it('a login that cannot be identified has no tags, so no administrator rights are assumed', async () => {
    const { profile } = await probe(
      broker('4.3.6', { '/api/whoami': brokerError(401) }),
    );

    expect(profile.identity).toEqual({
      user: '',
      tags: [],
      isAdmin: false,
      canMonitor: false,
      isPolicymaker: false,
    });
    expect(profile.restrictions.definitionsExport).toBe('none');
  });

  it('the TLS and AMQP handshakes: a failed or missing check is never "verified", and measured limits outrank the preset', async () => {
    const wire = createFakeWire();
    wire.tlsResult = { kind: 'failed', failure: { reason: 'tls-untrusted' } };
    wire.amqpResult = { ok: true, channelMax: 2047, frameMax: 131072 };

    const failed = await probe(broker('4.3.6'), { wire });
    wire.tlsResult = {
      kind: 'checked',
      verified: true,
      insecureOverride: false,
      notAfter: 9_999,
    };
    const checked = await probe(broker('4.3.6'), { wire });
    wire.amqpResult = { ok: false, failure: { reason: 'unreachable' } };
    const blocked = await probe(broker('4.3.6'), { wire });

    expect(failed.profile.tls).toEqual({
      verified: false,
      insecureOverride: false,
    });
    expect(failed.run.steps.find((s) => s.id === 'tls')?.status).toBe('failed');
    expect(checked.profile.tls).toEqual({
      verified: true,
      notAfter: 9_999,
      insecureOverride: false,
    });
    expect(checked.profile.limits).toMatchObject({
      channelMax: 2047,
      frameMax: 131072,
    });
    expect(blocked.profile.limits.frameMax).toBeUndefined();
    expect(
      blocked.run.steps.find((s) => s.id === 'amqp-handshake'),
    ).toMatchObject({
      status: 'unavailable',
      detail: 'unreachable',
    });
    expect(wire.calls).toContain('amqpHandshake');
  });

  it('a step that fails does not stop the probe, and an abort does', async () => {
    const failing = await probe(
      broker('4.3.6', { '/api/extensions': brokerError(500) }),
    );
    expect(failing.run.steps.find((s) => s.id === 'extensions')).toMatchObject({
      status: 'failed',
    });
    expect(failing.profile.product).toBe('rabbitmq');

    const controller = new AbortController();
    controller.abort();
    await expect(
      probe(broker('4.3.6'), { signal: controller.signal }),
    ).rejects.toThrow();
  });
});

describe('providers and vendors', () => {
  it('a host name names the provider; provider-owned objects name it behind a custom host; a disagreement is unknown', async () => {
    const aws = { host: 'b-1.mq.us-east-1.on.aws', managementTls: true };
    const owned = {
      '/api/policies': [{ name: 'AWS-DEFAULT-POLICY-ha', vhost: '/' }],
      '/api/operator-policies': [
        { name: 'default_operator_policy_AWS_managed', vhost: '/' },
      ],
      '/api/users': [{ name: 'monitoring-AWS-OWNED-DO-NOT-DELETE' }],
    };
    const wire = createFakeWire();

    wire.target = aws;
    expect((await probe(broker('4.3.6'), { wire })).profile.provider).toBe(
      'amazon-mq',
    );

    wire.target = { host: 'mq.corp.example', managementTls: true };
    const behind = await probe(broker('4.3.6', owned), { wire });
    expect(behind.profile.provider).toBe('amazon-mq');
    expect(behind.profile.managedObjects).toEqual([
      {
        kind: 'policy',
        vhost: '/',
        name: 'AWS-DEFAULT-POLICY-ha',
        managedBy: 'provider',
      },
      {
        kind: 'operator-policy',
        vhost: '/',
        name: 'default_operator_policy_AWS_managed',
        managedBy: 'provider',
      },
      {
        kind: 'user',
        name: 'monitoring-AWS-OWNED-DO-NOT-DELETE',
        managedBy: 'provider',
      },
    ]);
    expect(behind.profile.versions.build).toBe('commercial-or-unknown');

    wire.target = { host: 'x.rmq3.cloudamqp.com', managementTls: true };
    expect((await probe(broker('4.3.6'), { wire })).profile.provider).toBe(
      'cloudamqp-shared',
    );
    expect(
      (await probe(broker('4.3.6', owned), { wire })).profile.provider,
    ).toBe('unknown');

    wire.target = { host: '127.0.0.1', managementTls: false };
    expect((await probe(broker('4.3.6'), { wire })).profile.provider).toBe(
      'self-hosted',
    );
    expect(
      (await probe(broker('4.3.6'), { wire })).profile.versions.build,
    ).toBe('oss');
  });

  it('users are read only for an administrator', async () => {
    const tagless = await probe(
      broker('4.3.6', {
        '/api/whoami': { name: 'guest', tags: ['monitoring'] },
      }),
    );
    const admin = await probe(broker('4.3.6'));

    expect(tagless.scripted.requests.map((r) => r.path)).not.toContain(
      '/api/users',
    );
    expect(admin.scripted.requests.map((r) => r.path)).toContain('/api/users');
  });

  it('OAuth: the issuer is read from bootstrap.js only when it says OAuth is on, and from /api/auth for 4.1 and earlier', async () => {
    const script =
      'import {oauth_initialize} from "./helper.js";set_oauth_settings({"oauth_enabled":true,"oauth_provider_url":"https://idp.example/realms/mq"});window.x = 1;';
    // What a 4.3.6 broker with OAuth off serves, as the lab recorded it.
    expect(
      oauthFromBootstrap(
        'import {oauth_initialize} from "./helper.js";set_oauth_settings({"oauth_enabled":false});window.oauth_initialize = oauth_initialize;',
      ),
    ).toBeUndefined();
    expect(oauthFromBootstrap(script)).toBe('https://idp.example/realms/mq');
    expect(
      oauthFromBootstrap(
        '{"oauth_enabled": false, "oauth_provider_url": "https://idp.example"}',
      ),
    ).toBeUndefined();
    expect(
      oauthFromBootstrap(
        '{"oauth_enabled": true, "oauth_provider_url": "javascript:alert(1)"}',
      ),
    ).toBeUndefined();

    const viaScript = await probe(
      broker('4.3.6', { '/js/oidc-oauth/bootstrap.js': script }),
    );
    expect(viaScript.profile.auth.oauth).toEqual({
      issuer: 'https://idp.example/realms/mq',
      pinned: false,
      source: 'bootstrap.js',
    });
    const viaApi = await probe(
      broker('4.0.9', {
        '/api/auth': {
          oauth_enabled: true,
          oauth_provider_url: 'https://idp.example',
        },
      }),
    );
    expect(viaApi.profile.auth.oauth?.source).toBe('api/auth');
    expect((await probe(broker('4.3.6'))).profile.auth.oauth).toBeUndefined();
  });
});

describe('fingerprint and cache', () => {
  const principal = createTestPrincipal();
  const ctx = (key: string) =>
    createTestContext({ principal, idempotencyKey: key });

  it('the fingerprint ignores the time of the probe and the order of the nodes, and follows what a decision reads', async () => {
    const one = await probe(
      broker('4.3.6', cluster({ 'rabbit@a': '4.3.6', 'rabbit@b': '4.3.6' })),
    );
    const reversed = await probe(
      broker('4.3.6', cluster({ 'rabbit@b': '4.3.6', 'rabbit@a': '4.3.6' })),
    );
    const upgraded = await probe(
      broker('4.3.6', cluster({ 'rabbit@a': '4.3.7', 'rabbit@b': '4.3.7' })),
    );

    expect(one.profile.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(reversed.profile.fingerprint).toBe(one.profile.fingerprint);
    expect(upgraded.profile.fingerprint).not.toBe(one.profile.fingerprint);
    const later = buildProfile({
      connectionId: CID,
      probedAt: 99_999,
      facts: one.run.facts,
      registry: semanticsRegistry,
      lastVerified: [],
    });
    expect(later.fingerprint).toBe(one.profile.fingerprint);
  });

  it('probe.run caches the profile, says whether it changed, and profile.get returns what was cached', async () => {
    const deps = createCapabilitiesFakeDeps();
    const engine = createTestExecutor();
    engine.executor.register(
      createProbeRunAction(deps),
      createProfileGetAction(deps),
    );

    await expect(
      engine.executor.run(profileGet, { cid: 'c1' }, ctx('get-0')),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const first = await engine.executor.run(
      probeRun,
      { cid: 'c1' },
      ctx('probe-1'),
    );
    const second = await engine.executor.run(
      probeRun,
      { cid: 'c1' },
      ctx('probe-2'),
    );
    const read = await engine.executor.run(
      profileGet,
      { cid: 'c1' },
      ctx('get-1'),
    );

    if (
      first.kind !== 'output' ||
      second.kind !== 'output' ||
      read.kind !== 'output'
    ) {
      throw new Error('expected outputs');
    }
    expect(first.output.changed).toBe(true);
    expect(second.output.changed).toBe(false);
    expect(first.output.steps.map((s) => s.id)).toEqual([...PROBE_STEP_IDS]);
    expect(read.output.profile).toEqual(second.output.profile);
    expect(deps.profiles.rows.get('c1')?.fingerprint).toBe(
      (second.output.profile as { fingerprint: string }).fingerprint,
    );
  });

  it('a broker that cannot be read at all is a Problem, and the cached profile is kept', async () => {
    const deps = createCapabilitiesFakeDeps({ seeded: true });
    const before = deps.profiles.rows.get('c1');
    deps.scripted.route('/api/overview', brokerError(401));
    const engine = createTestExecutor();
    engine.executor.register(createProbeRunAction(deps));

    await expect(
      engine.executor.run(probeRun, { cid: 'c1' }, ctx('probe-401')),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    deps.scripted.route('/api/overview', brokerError(503));
    await expect(
      engine.executor.run(probeRun, { cid: 'c1' }, ctx('probe-503')),
    ).rejects.toMatchObject({ code: 'BROKER_UNREACHABLE' });

    expect(deps.profiles.rows.get('c1')).toBe(before);
  });

  it("someone else's private connection is reported as missing by both actions", async () => {
    const deps = createCapabilitiesFakeDeps({
      ownerId: 'someone-else',
      seeded: true,
    });
    const engine = createTestExecutor();
    engine.executor.register(
      createProbeRunAction(deps),
      createProfileGetAction(deps),
    );

    await expect(
      engine.executor.run(probeRun, { cid: 'c1' }, ctx('p')),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      engine.executor.run(profileGet, { cid: 'c1' }, ctx('g')),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(deps.scripted.requests).toEqual([]);
  });

  it('a cached profile that no longer fits the schema is "ask again", not a crash', async () => {
    const deps = createCapabilitiesFakeDeps({ seeded: true });
    const row = deps.profiles.rows.get('c1');
    if (row === undefined) throw new Error('not seeded');
    deps.profiles.rows.set('c1', { ...row, profile: { schemaVersion: 0 } });
    const engine = createTestExecutor();
    engine.executor.register(createProfileGetAction(deps));

    await expect(
      engine.executor.run(profileGet, { cid: 'c1' }, ctx('stale')),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

const MIN = {
  '/api/overview': {
    node: 'rabbit@a',
    product_name: 'RabbitMQ',
    rabbitmq_version: '4.3.6',
  },
  '/api/whoami': { name: 'guest', tags: ['administrator'] },
};
