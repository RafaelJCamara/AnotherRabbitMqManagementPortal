// Test support for the status bar: the connection and its cached BrokerProfile as the engine would
// answer `connections.get` and `profile.get`, and a way to hold an answer back (the loading state).
import type { TransportRequest, TransportResponse } from '@app/ui-platform';
import { signal } from '@angular/core';
import type { LiveClientState } from '@app/ui-data';
import { LiveClient } from '@app/ui-data';
import { jsonResponse, problemResponse } from '@app/ui-platform/testing';

import { LayoutBackend, problem } from '../layout/layout-fixtures';

const CONNECTION_URL = /^\/api\/v1\/connections\/([^/]+)$/;
const PROFILE_URL = /^\/api\/v1\/connections\/([^/]+)\/profile$/;

/** A `connections.get` answer body (secrets are only reported as set or not). */
export function connectionBody(
  cid: string,
  name: string,
  envClass: 'prod' | 'staging' | 'test' | 'dev' | 'local',
): unknown {
  const secret = { isSet: true, updatedAt: 1 };
  return {
    profile: {
      id: cid,
      name,
      envClass,
      color: null,
      visibility: 'private',
      canEdit: true,
      http: {
        url: 'http://localhost:15672',
        host: 'localhost',
        port: 15672,
        tls: false,
        pathPrefix: null,
        auth: { kind: 'basic', username: 'guest', secret },
      },
      amqp: {
        host: 'localhost',
        port: 5672,
        tls: false,
        vhost: '/',
        auth: { kind: 'plain', username: 'guest', secret },
      },
      createdAt: 1,
      updatedAt: 1,
    },
  };
}

export interface ProfileOptions {
  readonly version?: string;
  readonly era?: '3.13' | '4.0-4.2' | '4.3' | '4.4';
  readonly conservative?: boolean;
  readonly verification?:
    | 'verified'
    | 'unverified-patch'
    | 'unverified-minor'
    | 'unknown-build';
  readonly stats?: { disabled: boolean; queueTotals: boolean };
}

/** A schemaVersion 1 BrokerProfile, as plain JSON (what `profile.get` carries). */
export function brokerProfileBody(
  cid: string,
  options: ProfileOptions = {},
): unknown {
  const version = options.version ?? '4.3.6';
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  const semver = { major, minor, patch, raw: version };
  return {
    schemaVersion: 1,
    connectionId: cid,
    probedAt: 1_760_000_000_000,
    fingerprint: 'fp-1',
    semanticsVersion: 'sem-2026.10.1',
    product: 'rabbitmq',
    provider: 'self-hosted',
    versions: {
      min: semver,
      perNode: { 'rabbit@a': semver },
      mixed: false,
      build: 'oss',
    },
    era: {
      value: options.era ?? '4.3',
      reasons: [],
      conservative: options.conservative ?? false,
    },
    verification: options.verification ?? 'verified',
    lbFronted: { value: false, evidence: [] },
    nodes: [{ name: 'rabbit@a', running: true }],
    identity: {
      user: 'guest',
      tags: [],
      isAdmin: true,
      canMonitor: true,
      isPolicymaker: true,
    },
    featureFlags: {},
    deprecatedFeaturesUsed: [],
    stats: options.stats ?? { disabled: false, queueTotals: true },
    classicEnabled: true,
    exchangeTypes: ['direct'],
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

/** The layout backend that also answers `connections.get` and `profile.get`. */
export class StatusBackend extends LayoutBackend {
  readonly connections = new Map<string, unknown>();
  /** `profile.get` bodies; a missing entry answers 404, a `null` profile is `{ profile: null }`. */
  readonly profiles = new Map<string, unknown>();
  readonly profileRequests: string[] = [];
  #held: Promise<void> | null = null;
  #release: (() => void) | null = null;

  /** Holds every `profile.get` answer back until `release()`. */
  hold(): void {
    this.#held = new Promise<void>((resolve) => {
      this.#release = resolve;
    });
  }

  release(): void {
    this.#release?.();
    this.#held = null;
    this.#release = null;
  }

  override async handle(request: TransportRequest): Promise<TransportResponse> {
    const profile = PROFILE_URL.exec(request.url)?.[1];
    if (profile !== undefined && request.method === 'GET') {
      this.profileRequests.push(profile);
      await this.#held;
      return this.profiles.has(profile)
        ? jsonResponse(200, { profile: this.profiles.get(profile) })
        : problemResponse(
            problem(500, 'INTERNAL', { title: 'Profile failed' }),
          );
    }
    const connection = CONNECTION_URL.exec(request.url)?.[1];
    if (connection !== undefined && request.method === 'GET') {
      return this.connections.has(connection)
        ? jsonResponse(200, this.connections.get(connection))
        : problemResponse(
            problem(404, 'NOT_FOUND', { title: 'No such connection' }),
          );
    }
    return super.handle(request);
  }
}
/** The parts of the live client the status bar and the skew banner read, as plain signals. */
export class FakeLive {
  readonly state = signal<LiveClientState>('idle');
  readonly engineVersion = signal<string | undefined>(undefined);
  readonly goaway = signal<{ reason: string } | undefined>(undefined);

  /** The provider that puts this stand-in where `LiveClient` is injected. */
  get provider() {
    return { provide: LiveClient, useValue: this as unknown as LiveClient };
  }
}
