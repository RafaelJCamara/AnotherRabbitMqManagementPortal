// The part of the engine the connections pages call, as a fake engine handler: the profiles in memory, the two
// tests, the probe and the profile, and the prod lock as the engine applies it today (an update or a delete is
// refused with 422 GATE_BLOCKED, source `prod-lock`, fix `ops.arm`, until the connection is armed). A spec can
// script any answer. Never part of the library build.
import type { ConnectionProfile, Problem } from '@app/contracts';
import type { TransportRequest, TransportResponse } from '@app/ui-platform';
import { jsonResponse, problemResponse } from '@app/ui-platform/testing';

import { profileFixture } from './fixtures';

export function problemOf(
  status: number,
  code: Problem['code'],
  extra: Partial<Problem> = {},
): Problem {
  return {
    type: 'about:blank',
    title: extra.title ?? 'Problem',
    status,
    code,
    correlationId: 'fake-engine',
    retryable: false,
    ...extra,
  };
}

/** A schemaVersion 1 BrokerProfile as plain JSON (what `profile.get` and `probe.run` carry). */
export function brokerProfileBody(
  cid: string,
  options: {
    readonly gates?: Readonly<Record<string, unknown>>;
    readonly verification?: string;
  } = {},
): Record<string, unknown> {
  const semver = { major: 4, minor: 3, patch: 6, raw: '4.3.6' };
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
    era: { value: '4.3', reasons: [], conservative: false },
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
    stats: { disabled: false, queueTotals: true },
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
    gates: { ...(options.gates ?? {}) },
  };
}

const PROBE_STEPS = [
  'tls',
  'host-fingerprint',
  'oauth-discovery',
  'identity',
  'overview',
  'extensions',
  'nodes',
  'feature-flags',
  'vendor-fingerprints',
  'exchanges',
  'prometheus',
  'amqp-handshake',
] as const;

const SEGMENT = '([^/?]+)';

export class FakeConnections {
  /** The profiles the engine has, in listing order. */
  profiles: ConnectionProfile[] = [];
  /** Whether update and delete are refused until the connection is armed (the engine's behaviour today, OQ-785). */
  requireArm = true;
  /** The connections armed so far, with the length of the window the engine answers with. */
  readonly armed = new Set<string>();
  armWindowMs = 15 * 60_000;
  /** The `profile.get` body of a connection; `null` answers NOT_FOUND (not probed). */
  profile: ((cid: string) => unknown) | null = (cid) =>
    brokerProfileBody(cid, {
      gates: {
        'amqp.peek': { enabled: true },
        'amqp.publish': {
          enabled: false,
          reason: 'The user has no write permission.',
          source: 'https://www.rabbitmq.com/docs/access-control',
        },
      },
    });
  /** The scripted answers; a missing entry answers as the engine would. */
  testHttp: (body: Record<string, unknown>) => unknown = () => ({
    ok: true,
    target: { url: 'http://127.0.0.1:15672' },
    tookMs: 12,
    broker: {
      product: 'RabbitMQ',
      version: '4.3.6',
      clusterName: 'rabbit@a',
      user: 'guest',
      tags: ['administrator'],
    },
    amqpPorts: { plain: 5672, tls: 5671 },
  });
  testAmqp: (body: Record<string, unknown>) => unknown = () => ({
    ok: true,
    target: { host: '127.0.0.1', port: 5672, tls: false, vhost: '/' },
    tookMs: 8,
    gates: { 'amqp.peek': { enabled: true } },
  });
  /** Makes the matching call answer this Problem (until cleared). */
  failure: {
    list?: Problem;
    get?: Problem;
    create?: Problem;
    update?: Problem;
    delete?: Problem;
    arm?: Problem;
    probe?: Problem;
    profile?: Problem;
  } = {};
  /** While set, the test calls answer only when it settles (the busy state). */
  holdTests: Promise<void> | null = null;
  readonly #lines: string[] = [];
  readonly #bodies: { line: string; body: Record<string, unknown> }[] = [];
  #next = 1;

  /** Every request line this fake answered, for specs that count calls. */
  get requestLines(): readonly string[] {
    return this.#lines;
  }

  /** The JSON bodies of the requests that had one, with their request line. */
  get bodies(): readonly { line: string; body: Record<string, unknown> }[] {
    return this.#bodies;
  }

  /** Seeds the engine with profiles. */
  seed(...ids: readonly string[]): this {
    this.profiles = ids.map((id) => profileFixture(id));
    return this;
  }

  handler = async (request: TransportRequest): Promise<TransportResponse> => {
    const url = new URL(request.url, 'http://engine.test');
    const path = url.pathname.replace('/api/v1', '');
    const line = `${request.method} ${path}`;
    this.#lines.push(line);
    const body =
      typeof request.body === 'string' && request.body !== ''
        ? (JSON.parse(request.body) as Record<string, unknown>)
        : {};
    if (typeof request.body === 'string' && request.body !== '') {
      this.#bodies.push({ line, body });
    }

    if (request.method === 'GET' && path === '/connections') {
      return this.failure.list
        ? problemResponse(this.failure.list)
        : this.#list(url);
    }
    if (request.method === 'POST' && path === '/connections') {
      return this.failure.create
        ? problemResponse(this.failure.create)
        : this.#create(body);
    }
    if (request.method === 'POST' && path === '/connections/test-http') {
      await this.holdTests;
      return jsonResponse(200, this.testHttp(body));
    }
    if (request.method === 'POST' && path === '/connections/test-amqp') {
      await this.holdTests;
      return jsonResponse(200, this.testAmqp(body));
    }
    const one = new RegExp(`^/connections/${SEGMENT}$`).exec(path);
    if (one?.[1] !== undefined) {
      const cid = decodeURIComponent(one[1]);
      if (request.method === 'GET') {
        return this.failure.get
          ? problemResponse(this.failure.get)
          : this.#get(cid);
      }
      if (request.method === 'PATCH') return this.#update(cid, body);
      if (request.method === 'DELETE') return this.#delete(cid);
    }
    const sub = new RegExp(`^/connections/${SEGMENT}/(.+)$`).exec(path);
    if (sub?.[1] !== undefined && sub[2] !== undefined) {
      const cid = decodeURIComponent(sub[1]);
      switch (`${request.method} ${sub[2]}`) {
        case 'POST arm':
          return this.failure.arm
            ? problemResponse(this.failure.arm)
            : this.#arm(cid);
        case 'POST disarm':
          return this.#disarm(cid);
        case 'GET profile':
          return this.#profile(cid);
        case 'POST probe':
          return this.#probe(cid);
      }
    }
    return problemResponse(
      problemOf(404, 'NOT_FOUND', { title: 'Not found', detail: line }),
    );
  };

  #list(url: URL): TransportResponse {
    const limit = Number(url.searchParams.get('limit') ?? '25');
    const start = Number(url.searchParams.get('cursor') ?? '0');
    const end = Math.min(this.profiles.length, start + limit);
    return jsonResponse(200, {
      items: this.profiles.slice(start, end),
      ...(end < this.profiles.length ? { nextCursor: String(end) } : {}),
    });
  }

  #get(cid: string): TransportResponse {
    const found = this.profiles.find((p) => p.id === cid);
    return found === undefined
      ? problemResponse(
          problemOf(404, 'NOT_FOUND', { title: 'No such connection' }),
        )
      : jsonResponse(200, { profile: found });
  }

  /** Builds the profile a create would save: the names and addresses given, the engine's defaults for the rest. */
  #create(body: Record<string, unknown>): TransportResponse {
    const http = (body.http ?? {}) as Record<string, unknown>;
    const amqp = (body.amqp ?? {}) as Record<string, unknown>;
    const id = `c${String(this.profiles.length + this.#next++)}`;
    const base = profileFixture(id, {
      name: String(body.name),
      envClass: body.envClass as ConnectionProfile['envClass'],
    });
    const created: ConnectionProfile = {
      ...base,
      http: {
        ...base.http,
        ...(typeof http.host === 'string' ? { host: http.host } : {}),
        ...(typeof http.port === 'number' ? { port: http.port } : {}),
      },
      amqp: {
        ...base.amqp,
        ...(typeof amqp.host === 'string' ? { host: amqp.host } : {}),
        ...(typeof amqp.port === 'number' ? { port: amqp.port } : {}),
      },
    };
    this.profiles = [...this.profiles, created];
    return jsonResponse(200, { profile: created });
  }

  #locked(cid: string): TransportResponse | undefined {
    if (!this.requireArm || this.armed.has(cid)) return undefined;
    return problemResponse(
      problemOf(422, 'GATE_BLOCKED', {
        title: 'The call is blocked',
        detail: 'The production lock is on.',
        gate: {
          enabled: false,
          reason:
            'This is a production connection and it is locked. Arm it to make changes for 15 minutes.',
          source: 'prod-lock',
          fix: { actionId: 'ops.arm' as never, input: { connectionId: cid } },
        },
      }),
    );
  }

  #update(cid: string, body: Record<string, unknown>): TransportResponse {
    if (this.failure.update) return problemResponse(this.failure.update);
    const found = this.profiles.find((p) => p.id === cid);
    if (found === undefined) {
      return problemResponse(
        problemOf(404, 'NOT_FOUND', { title: 'No such connection' }),
      );
    }
    const locked = this.#locked(cid);
    if (locked) return locked;
    const updated: ConnectionProfile = {
      ...found,
      name: typeof body.name === 'string' ? body.name : found.name,
      envClass:
        (body.envClass as ConnectionProfile['envClass'] | undefined) ??
        found.envClass,
      updatedAt: found.updatedAt + 1,
    };
    this.profiles = this.profiles.map((p) => (p.id === cid ? updated : p));
    return jsonResponse(200, { profile: updated });
  }

  #delete(cid: string): TransportResponse {
    if (this.failure.delete) return problemResponse(this.failure.delete);
    const locked = this.#locked(cid);
    if (locked) return locked;
    const had = this.profiles.some((p) => p.id === cid);
    this.profiles = this.profiles.filter((p) => p.id !== cid);
    return jsonResponse(200, { deleted: had });
  }

  #arm(cid: string): TransportResponse {
    this.armed.add(cid);
    return jsonResponse(200, {
      armed: true,
      connectionId: cid,
      armedAt: 5_000,
      expiresAt: 5_000 + this.armWindowMs,
    });
  }

  #disarm(cid: string): TransportResponse {
    const was = this.armed.delete(cid);
    return jsonResponse(200, {
      armed: false,
      connectionId: cid,
      wasArmed: was,
    });
  }

  #profile(cid: string): TransportResponse {
    if (this.failure.profile) return problemResponse(this.failure.profile);
    if (this.profile === null) {
      return problemResponse(
        problemOf(404, 'NOT_FOUND', {
          title: 'No profile yet',
          detail: 'Run the probe first.',
        }),
      );
    }
    return jsonResponse(200, { profile: this.profile(cid) });
  }

  #probe(cid: string): TransportResponse {
    if (this.failure.probe) return problemResponse(this.failure.probe);
    return jsonResponse(200, {
      profile: this.profile?.(cid) ?? brokerProfileBody(cid),
      changed: true,
      steps: PROBE_STEPS.map((id) => ({
        id,
        status: id === 'prometheus' ? 'unavailable' : 'ok',
        ...(id === 'prometheus' ? { detail: 'not enabled' } : {}),
      })),
    });
  }
}
