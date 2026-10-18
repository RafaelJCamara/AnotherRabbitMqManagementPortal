import { describe, expect, it } from 'vitest';
import {
  BROKER_PROFILE_SCHEMA_VERSION,
  BrokerProfileSchema,
  type BrokerProfile,
} from './broker-profile.ts';

/** The smallest profile the schema accepts, as a plain JSON value (what a stored profile is). */
function profileJson(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    connectionId: 'local-dev',
    probedAt: 1_760_000_000_000,
    fingerprint: 'fp-1',
    semanticsVersion: 'sem-2026.10.1',
    product: 'rabbitmq',
    provider: 'self-hosted',
    versions: {
      min: { major: 4, minor: 3, patch: 6, raw: '4.3.6' },
      perNode: { 'rabbit@a': { major: 4, minor: 3, patch: 6, raw: '4.3.6' } },
      mixed: false,
      build: 'oss',
    },
    era: {
      value: '4.3',
      reasons: ['all nodes are 4.3 or later'],
      conservative: false,
    },
    verification: 'verified',
    lbFronted: { value: false, evidence: [] },
    nodes: [{ name: 'rabbit@a', running: true, qqMachineVersion: 8 }],
    identity: {
      user: 'guest',
      tags: ['administrator'],
      isAdmin: true,
      canMonitor: true,
      isPolicymaker: true,
    },
    featureFlags: { 'rabbitmq_4.3.0': 'enabled' },
    deprecatedFeaturesUsed: [],
    stats: { disabled: false, queueTotals: true },
    classicEnabled: true,
    exchangeTypes: ['direct', 'fanout', 'topic', 'headers'],
    extensions: [],
    restrictions: {
      operatorPolicyChanges: 'allowed',
      qqReplicaOps: 'allowed',
      definitionsExport: 'full',
    },
    limits: { preAuthFrameMax: 8192 },
    prometheus: {
      endpoints: [],
      perObjectAllowed: true,
      queueFilter: false,
      minIntervalSec: 15,
    },
    streams: {
      supported: true,
      paths: ['amqp091'],
      streamProtocolReachable: 'unknown',
    },
    firehose: { available: 'none' },
    auth: { httpChainSeparate: 'unknown' },
    tls: { verified: false, insecureOverride: false },
    managedObjects: [],
    hazards: [],
    gates: {},
  };
}

describe('BrokerProfileSchema', () => {
  it('accepts a schemaVersion 1 profile and keeps its values', () => {
    const parsed: BrokerProfile = BrokerProfileSchema.parse(profileJson());

    expect(parsed.schemaVersion).toBe(BROKER_PROFILE_SCHEMA_VERSION);
    expect(parsed.era).toEqual({
      value: '4.3',
      reasons: ['all nodes are 4.3 or later'],
      conservative: false,
    });
    expect(parsed.verification).toBe('verified');
  });

  it('rejects any other schemaVersion', () => {
    expect(
      BrokerProfileSchema.safeParse({ ...profileJson(), schemaVersion: 2 })
        .success,
    ).toBe(false);
  });

  it('rejects unknown keys (the contract is explicit)', () => {
    expect(
      BrokerProfileSchema.safeParse({ ...profileJson(), extra: true }).success,
    ).toBe(false);
  });

  it('rejects an era or verification outside the vocabulary', () => {
    const era = { value: '4.5', reasons: [], conservative: false };
    expect(
      BrokerProfileSchema.safeParse({ ...profileJson(), era }).success,
    ).toBe(false);
    expect(
      BrokerProfileSchema.safeParse({
        ...profileJson(),
        verification: 'trusted',
      }).success,
    ).toBe(false);
  });

  it('only allows the two pre-auth frame sizes', () => {
    const limits = { preAuthFrameMax: 1024 };
    expect(
      BrokerProfileSchema.safeParse({ ...profileJson(), limits }).success,
    ).toBe(false);
  });
});
