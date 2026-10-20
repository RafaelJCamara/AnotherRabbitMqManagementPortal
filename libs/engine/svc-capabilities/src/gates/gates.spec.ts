// The acceptance criteria AC-1 to AC-9 of M0-46 (feature gates). The brokers are the golden fixtures
// replayed through a scripted management API; the Amazon MQ broker is the 4.2.9 recording with the
// host name, the overview flag and the plugins that provider documents (see gates.fixture.ts).
import { BrokerProfileSchema, type BrokerProfile } from '@app/domain-model';
import { FeatureIdSchema, probeRun, profileGet } from '@app/contracts';
import { createTestContext, createTestExecutor } from '@app/kernel';
import { semanticsRegistry } from '@app/semantics';
import { describe, expect, it } from 'vitest';

import { createProbeRunAction } from '../actions/probe-run';
import { createProfileGetAction } from '../actions/profile-get';
import { fixtureRoutes, type FixtureTarget } from '../fixtures';
import { buildProfile } from '../profile-builder';
import { createCapabilitiesFakeDeps, sampleProfile } from '../testing';
import { computeGates, FEATURES } from './index';
import {
  AMAZON_HOST,
  amazonRoutes,
  brokerRoutes,
  probeBroker,
  wireFor,
} from './gates.fixture';

const gate = (profile: BrokerProfile, id: string) => {
  const found = profile.gates[id as keyof typeof profile.gates];
  if (found === undefined) throw new Error(`no gate ${id}`);
  return found;
};

describe('gates of an Amazon MQ 4.2 broker', () => {
  it('AC-1 Amazon MQ 4.2 closes streams, firehose and event audit, each with a reason and a source', async () => {
    const { profile } = await probeBroker(amazonRoutes(), {
      wire: wireFor(AMAZON_HOST),
    });

    expect(profile.provider).toBe('amazon-mq');
    for (const id of [
      'streams.browse',
      'tap.firehose',
      'audit.event-exchange',
    ]) {
      const decision = gate(profile, id);
      expect(decision.enabled, id).toBe(false);
      expect(decision.reason, id).toBeTruthy();
      expect(decision.source, id).toMatch(
        /^(provider preset amazon-mq|probe step)/,
      );
    }
    // The preset is the reason for streams and event audit; the probe is the one for the firehose.
    expect(gate(profile, 'streams.browse').source).toContain(
      'amazon-mq: https://',
    );
    expect(gate(profile, 'tap.firehose').source).toContain('probe steps');
  });

  it('AC-2 Amazon MQ operator-policy edits show the 405 remediation', async () => {
    const { profile } = await probeBroker(amazonRoutes(), {
      wire: wireFor(AMAZON_HOST),
    });

    const decision = gate(profile, 'policies.operator-edit');

    expect(decision.enabled).toBe(false);
    expect(decision.reason).toContain('HTTP 405');
    expect(decision.reason).toContain(
      'management.restrictions.operator_policy_changes.disabled=false',
    );
    expect(decision.reason).toContain('reboot');
    expect(decision.source).toContain('docs.aws.amazon.com');
    expect(decision).not.toHaveProperty('fix');
  });

  it('AC-4 a blocked provider preset closes streams even when the probe sees the stream plugin', async () => {
    const { profile } = await probeBroker(amazonRoutes({ keepStreams: true }), {
      wire: wireFor(AMAZON_HOST),
    });

    expect(profile.nodes[0]?.enabledPlugins).toContain('rabbitmq_stream');
    expect(profile.extensions).toContain('stream.js');
    const decision = gate(profile, 'streams.browse');
    expect(decision.enabled).toBe(false);
    expect(decision.source).toContain('provider preset amazon-mq');
  });
});

describe('gates of a self-hosted broker', () => {
  it('AC-3 a self-hosted 4.2.9 broker with the plugins opens streams, firehose, event audit and operator-policy edits', async () => {
    const { profile } = await probeBroker(brokerRoutes('4.2.9'));

    expect(profile.provider).not.toBe('amazon-mq');
    for (const id of [
      'streams.browse',
      'tap.firehose',
      'audit.event-exchange',
      'policies.operator-edit',
    ]) {
      expect(gate(profile, id), id).toEqual({ enabled: true, mode: 'full' });
    }
  });

  it('an overview that does not report the operator-policy flag keeps the edit gate closed', async () => {
    const overview = brokerRoutes('4.2.9')['/api/overview'] as object;
    const withoutFlag = { ...overview } as Record<string, unknown>;
    delete withoutFlag.is_op_policy_updating_enabled;
    const { profile } = await probeBroker(
      brokerRoutes('4.2.9', { '/api/overview': withoutFlag }),
    );

    expect(gate(profile, 'policies.operator-edit')).toMatchObject({
      enabled: false,
      source: 'probe step 5 (overview)',
    });
  });
});

describe('gates on every fixture', () => {
  const rabbit: FixtureTarget[] = [
    '3.13.7',
    '4.0.9',
    '4.1.8',
    '4.2.9',
    '4.3.6',
  ];
  const cases = [
    ...rabbit.flatMap((target) =>
      (['stats-on', 'stats-off'] as const).map((mode) => ({
        name: `${target} ${mode}`,
        routes: fixtureRoutes(target, mode),
      })),
    ),
    { name: 'lavinmq-2.10.2', routes: fixtureRoutes('lavinmq-2.10.2') },
    { name: 'amazon-mq', routes: amazonRoutes() },
  ];

  it('AC-7 every feature has a decision on every fixture and every closed gate has a reason and a source', async () => {
    for (const { name, routes } of cases) {
      const { profile } = await probeBroker(routes, {
        wire: wireFor(name === 'amazon-mq' ? AMAZON_HOST : undefined),
      });

      expect(Object.keys(profile.gates), name).toEqual(FEATURES);
      for (const [id, decision] of Object.entries(profile.gates)) {
        const text = `${decision.reason ?? ''} ${decision.source ?? ''}`;
        if (!decision.enabled) {
          expect(decision.reason, `${name} ${id}`).toBeTruthy();
          expect(decision.source, `${name} ${id}`).toBeTruthy();
        }
        expect(text, `${name} ${id}`).not.toMatch(
          /\/\/[^/\s]*@|\bat .*\.ts:\d|non-destructive|read-only/i,
        );
      }
      if (name.endsWith('stats-off')) {
        expect(gate(profile, 'audit.event-exchange').reason).toContain(
          'plugin state is unknown',
        );
      }
      if (name.startsWith('lavinmq')) {
        expect(gate(profile, 'streams.browse').enabled).toBe(false);
        expect(gate(profile, 'tap.firehose').enabled).toBe(false);
      }
    }
  });
});

describe('gates and the AMQP handshake', () => {
  const FEATURES_AMQP = [
    'amqp.peek',
    'amqp.tap',
    'amqp.publish',
    'amqp.replay',
  ];

  it('AC-8 a failed AMQP handshake closes the amqp features with the failure class and leaks no broker text', async () => {
    const secret =
      'ACCESS_REFUSED for user guest with password hunter2 at amqp://guest:hunter2@mq.example';
    const failed = await probeBroker(brokerRoutes('4.3.6'), {
      wire: wireFor(undefined, {
        ok: false,
        failure: { reason: 'auth-refused', detail: secret },
      }),
    });
    const fine = await probeBroker(brokerRoutes('4.3.6'));

    for (const id of FEATURES_AMQP) {
      expect(gate(failed.profile, id), id).toEqual({
        enabled: false,
        reason: 'the AMQP handshake failed: auth-refused',
        source: 'probe step 12 (amqp-handshake)',
      });
      expect(gate(fine.profile, id), id).toEqual({
        enabled: true,
        mode: 'full',
      });
    }
    expect(JSON.stringify(failed.profile.gates)).not.toContain('hunter2');
  });

  it('AC-12 (M0-FIX-1) a missing AMQP handshake closes the four amqp gates', async () => {
    const { profile, facts } = await probeBroker(brokerRoutes('4.3.6'));
    // The probe never ran step 12: the facts carry no handshake result at all.
    const withoutHandshake = { ...facts };
    delete withoutHandshake.amqp;
    const rebuilt = buildProfile({
      connectionId: profile.connectionId,
      probedAt: 5_000,
      facts: withoutHandshake,
      registry: semanticsRegistry,
      lastVerified: [],
    });

    for (const id of FEATURES_AMQP) {
      expect(gate(rebuilt, id), id).toEqual({
        enabled: false,
        reason: 'the AMQP handshake did not run',
        source: 'probe step 12 (amqp-handshake)',
      });
      // With the handshake the same broker opens them: the closure is the missing result alone.
      expect(gate(profile, id), id).toEqual({ enabled: true, mode: 'full' });
    }
    // Nothing else moves: the other gates are those of the same broker with a handshake.
    for (const id of FEATURES.filter(
      (feature) => !FEATURES_AMQP.includes(feature),
    )) {
      expect(gate(rebuilt, id), id).toEqual(gate(profile, id));
    }
    expect(rebuilt.fingerprint).not.toBe(profile.fingerprint);
  });
});

describe('gates are part of the profile', () => {
  it('AC-9 gates are deterministic, part of the fingerprint, schema-valid and cached with the profile', async () => {
    const { profile: first, facts } = await probeBroker(brokerRoutes('4.2.9'));
    const input = {
      connectionId: first.connectionId,
      probedAt: 5_000,
      registry: semanticsRegistry,
      lastVerified: [],
    };
    const second = buildProfile({ ...input, facts });
    const changed = buildProfile({
      ...input,
      facts: { ...facts, amqp: { ok: false, failure: { reason: 'timeout' } } },
    });

    expect(second.gates).toEqual(first.gates);
    expect(Object.keys(second.gates)).toEqual(Object.keys(first.gates));
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(changed.gates).not.toEqual(first.gates);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
    expect(BrokerProfileSchema.safeParse(changed).success).toBe(true);

    const deps = createCapabilitiesFakeDeps({ routes: brokerRoutes('4.2.9') });
    const engine = createTestExecutor();
    engine.executor.register(
      createProbeRunAction(deps),
      createProfileGetAction(deps),
    );
    const ctx = (key: string) => createTestContext({ idempotencyKey: key });
    const probed = await engine.executor.run(
      probeRun,
      { cid: 'c1' },
      ctx('p1'),
    );
    const read = await engine.executor.run(
      profileGet,
      { cid: 'c1' },
      ctx('g1'),
    );

    if (probed.kind !== 'output' || read.kind !== 'output') {
      throw new Error('expected outputs');
    }
    const cached = BrokerProfileSchema.parse(
      deps.profiles.rows.get('c1')?.profile,
    );
    expect(Object.keys(cached.gates)).toEqual(FEATURES);
    expect(BrokerProfileSchema.parse(read.output.profile).gates).toEqual(
      cached.gates,
    );
  });

  it('a feature whose decision cannot be reached is closed, and a registry row can close an open one', () => {
    const profile = sampleProfile();
    const broken = {
      ...semanticsRegistry,
      providerPreset: () => {
        throw new Error('boom');
      },
    };
    const closedByRow = {
      ...semanticsRegistry,
      gate: () => ({ enabled: false as const, reason: 'row says no' }),
    };

    const facts = { overviews: [], amqp: { ok: true as const } };
    const unreachable = computeGates({ profile, facts, registry: broken });
    const byRow = computeGates({ profile, facts, registry: closedByRow });

    expect(Object.keys(unreachable)).toEqual(FEATURES);
    expect(Object.values(unreachable).every((entry) => !entry.enabled)).toBe(
      true,
    );
    expect(byRow[FeatureIdSchema.parse('amqp.peek')]).toEqual({
      enabled: false,
      reason: 'row says no',
      source: 'semantics registry gate row',
    });
  });

  it('AC-13 (M0-FIX-1) an unreachable decision stays closed and names the error class, never its message', () => {
    const profile = sampleProfile();
    const facts = { overviews: [], amqp: { ok: true as const } };
    const secret = 'ACCESS_REFUSED hunter2 at amqp://guest:hunter2@mq.example';
    const throwing = (thrown: () => unknown) => ({
      ...semanticsRegistry,
      providerPreset: () => {
        throw thrown();
      },
    });
    const sources = (registry: typeof semanticsRegistry) => {
      const gates = computeGates({ profile, facts, registry });
      expect(Object.keys(gates)).toEqual(FEATURES);
      for (const [id, decision] of Object.entries(gates)) {
        // Closed, with the fixed reason; the message of the error is nowhere in the decision.
        expect(decision.enabled, id).toBe(false);
        expect(decision.reason, id).toBe(
          'this feature could not be decided, so it stays closed',
        );
        expect(JSON.stringify(decision), id).not.toContain('hunter2');
      }
      return [...new Set(Object.values(gates).map((entry) => entry.source))];
    };

    expect(sources(throwing(() => new TypeError(secret)))).toEqual([
      'svc-capabilities gates (TypeError)',
    ]);
    // A class of our own is named as it is called.
    class ProbeBoom extends Error {}
    expect(sources(throwing(() => new ProbeBoom(secret)))).toEqual([
      'svc-capabilities gates (ProbeBoom)',
    ]);
    // A thrown value that is not an error has no class to name.
    expect(sources(throwing(() => secret))).toEqual([
      'svc-capabilities gates (non-error)',
    ]);
    expect(sources(throwing(() => ({ message: secret })))).toEqual([
      'svc-capabilities gates (non-error)',
    ]);
    // A class name that is not a plain identifier (anything can be assigned to it) is not quoted.
    class Renamed extends Error {}
    Object.defineProperty(Renamed, 'name', { value: `x y: ${secret}` });
    expect(sources(throwing(() => new Renamed(secret)))).toEqual([
      'svc-capabilities gates (Error)',
    ]);

    // The same when it is a registry gate row that throws, after the profile opened the gate.
    const row = computeGates({
      profile,
      facts,
      registry: {
        ...semanticsRegistry,
        gate: () => {
          throw new RangeError(secret);
        },
      },
    });
    expect(row[FeatureIdSchema.parse('amqp.peek')]).toEqual({
      enabled: false,
      reason: 'this feature could not be decided, so it stays closed',
      source: 'svc-capabilities gates (RangeError)',
    });
  });
});
