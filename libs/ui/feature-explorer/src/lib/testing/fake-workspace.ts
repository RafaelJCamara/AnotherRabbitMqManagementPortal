// The parts of the engine the explorer's pages call besides the inventory, as a fake engine handler:
// `profile.get` (a BrokerProfile as plain JSON), and the saved views (`views.list`, `views.create`,
// `views.delete`) held in memory. A spec can make any of them fail with a Problem. Never part of the
// library build.
import type { Problem, SavedView } from '@app/contracts';
import type { TransportResponse } from '@app/ui-platform';
import {
  jsonResponse,
  problemResponse,
  type FakeHandler,
} from '@app/ui-platform/testing';

const PROFILE_URL = /^\/api\/v1\/connections\/([^/]+)\/profile$/;
const OVERVIEW_URL = /^\/api\/v1\/connections\/([^/]+)\/overview$/;
const VIEWS_URL = /^\/api\/v1\/views(?:\/([^/?]+))?(?:\?.*)?$/;

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

/** A schemaVersion 1 BrokerProfile as plain JSON (what `profile.get` carries). */
export function brokerProfileBody(
  cid: string,
  options: {
    readonly allowedActions?: readonly string[];
    readonly gates?: Readonly<Record<string, unknown>>;
    readonly stats?: { disabled: boolean; queueTotals: boolean };
    readonly hazards?: readonly string[];
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
    verification: 'verified',
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
    hazards: [...(options.hazards ?? [])],
    gates: { ...(options.gates ?? {}) },
    ...(options.allowedActions === undefined
      ? {}
      : { allowedActions: [...options.allowedActions] }),
  };
}

export class FakeWorkspace {
  /** The views the person has, in the order the engine lists them. */
  views: SavedView[] = [];
  /** The `profile.get` body; `null` answers NOT_FOUND (an unprobed connection). */
  profile: ((cid: string) => unknown) | null = (cid) =>
    brokerProfileBody(cid, {
      allowedActions: ['views.create', 'views.delete'],
    });
  /** Makes the matching call answer this Problem (once, or until cleared). */
  failure: {
    list?: Problem;
    create?: Problem;
    delete?: Problem;
    profile?: Problem;
    overview?: Problem;
  } = {};
  /** The `overview.get` answer of a connection; a missing one answers NOT_FOUND. */
  overview: ((cid: string) => unknown) | null = null;
  /** While set, overview.get answers only when it settles (the loading state). */
  holdOverview: Promise<void> | null = null;
  /** A page of views the engine says there are more of. */
  nextCursor: string | undefined;
  readonly #seen: string[] = [];
  #next = 1;

  /** Every request line this fake answered, for specs that count calls. */
  get requestLines(): readonly string[] {
    return this.#seen;
  }

  add(view: Pick<SavedView, 'name' | 'kind' | 'definition'>): SavedView {
    const saved: SavedView = {
      id: `view-${String(this.#next++)}`,
      createdAt: 1,
      updatedAt: 1,
      ...view,
    };
    this.views.push(saved);
    return saved;
  }

  readonly handler: FakeHandler = (request) => {
    this.#seen.push(`${request.method} ${request.url}`);
    const profile = PROFILE_URL.exec(request.url)?.[1];
    if (profile !== undefined && request.method === 'GET') {
      if (this.failure.profile) return problemResponse(this.failure.profile);
      return this.profile === null
        ? problemResponse(problemOf(404, 'NOT_FOUND', { title: 'Not found' }))
        : jsonResponse(200, {
            profile: this.profile(decodeURIComponent(profile)),
          });
    }
    const overview = OVERVIEW_URL.exec(request.url)?.[1];
    if (overview !== undefined && request.method === 'GET') {
      const answer = (): TransportResponse => {
        if (this.failure.overview)
          return problemResponse(this.failure.overview);
        return this.overview === null
          ? problemResponse(problemOf(404, 'NOT_FOUND', { title: 'Not found' }))
          : jsonResponse(200, this.overview(decodeURIComponent(overview)));
      };
      return this.holdOverview === null
        ? answer()
        : this.holdOverview.then(answer);
    }
    const views = VIEWS_URL.exec(request.url);
    if (views) {
      const id = views[1];
      if (request.method === 'GET' && id === undefined) {
        if (this.failure.list) return problemResponse(this.failure.list);
        const kind = new URL(
          request.url,
          'http://engine.test',
        ).searchParams.get('kind');
        const items = this.views.filter(
          (v) => kind === null || v.kind === kind,
        );
        return jsonResponse(200, {
          items,
          ...(this.nextCursor === undefined
            ? {}
            : { nextCursor: this.nextCursor }),
        });
      }
      if (request.method === 'POST' && id === undefined) {
        if (this.failure.create) return problemResponse(this.failure.create);
        const body = JSON.parse(
          typeof request.body === 'string' ? request.body : '{}',
        ) as {
          name: string;
          kind: string;
          definition: Record<string, unknown>;
        };
        return jsonResponse(200, { view: this.add(body) });
      }
      if (request.method === 'DELETE' && id !== undefined) {
        if (this.failure.delete) return problemResponse(this.failure.delete);
        this.views = this.views.filter((v) => v.id !== decodeURIComponent(id));
        return jsonResponse(200, {});
      }
    }
    return problemResponse(
      problemOf(404, 'NOT_FOUND', {
        title: 'Not found',
        detail: `${request.method} ${request.url}`,
      }),
    );
  };
}
