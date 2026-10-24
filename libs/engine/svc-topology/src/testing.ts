// Fakes for the ports of this module, shared by its specs, by the architecture manifest
// (tools/arch-tests) and by the HTTP specs (libs/testkit): a scripted management API that answers
// from a plain description of vhosts, a probed profile, and the connection store.
import type { ErrorCode } from '@app/contracts';
import { BrokerProfileSchema, type BrokerProfile } from '@app/domain-model';
import { AppError, createManualClock, type ManualClock } from '@app/kernel';
import type { Lane, MgmtGetRequest, MgmtReadPort } from '@app/ports';

import type { TopologyLimits, TopologyModuleDeps } from './deps';
import type { ActionDeps } from './internal/load';
import { createSnapshotReader } from './internal/snapshot';

/** The connection every fake starts with: owned by the test principal (`user-1`). */
export const FAKE_CONNECTION_ID = 'c1';

/** What a spec writes for a queue; a key left out stays out of the answer (a stats gap). */
export interface FakeQueue {
  readonly name: string;
  readonly type?: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
  /** `null` is "no policy"; leave the key out to model statistics off below 4.2.5. */
  readonly policy?: string | null;
  readonly operator_policy?: string | null;
  readonly delivery_limit?: number | string | null;
}

export interface FakeExchange {
  readonly name: string;
  readonly type?: string;
  readonly internal?: boolean;
  readonly arguments?: Readonly<Record<string, unknown>>;
}

export interface FakeBinding {
  readonly source: string;
  readonly destination: string;
  readonly destination_type?: 'queue' | 'exchange';
  readonly routing_key?: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
}

export interface FakePolicy {
  readonly name: string;
  readonly pattern: string;
  readonly 'apply-to'?: string;
  readonly priority?: number;
  readonly definition: Readonly<Record<string, unknown>>;
}

/** A list the principal may not read, as the port reports it (403, or 405 from a provider). */
export type Refusal = 'forbidden' | 'method-not-allowed' | 'not-found';

export interface FakeVhost {
  readonly queues?: readonly FakeQueue[];
  readonly exchanges?: readonly FakeExchange[];
  readonly bindings?: readonly FakeBinding[];
  readonly policies?: readonly FakePolicy[] | Refusal;
  readonly operatorPolicies?: readonly FakePolicy[] | Refusal;
  /** Queue names with a consumer that acknowledges, and with one that does not. */
  readonly consumers?:
    | {
        readonly acking?: readonly string[];
        readonly noAck?: readonly string[];
      }
    | Refusal;
}

/** One management request, as the scripted broker saw it. */
export interface RecordedRequest {
  readonly path: string;
  readonly query: Readonly<Record<string, string | number | boolean>>;
  readonly lane: Lane;
}

export interface ScriptedBroker {
  readonly read: MgmtReadPort;
  readonly requests: RecordedRequest[];
  /** Called with every request before it is answered: return an error to fail it. Settable by a spec. */
  intercept?:
    | ((request: RecordedRequest, ordinal: number) => Error | undefined)
    | undefined;
}

/** A small, healthy vhost: a topic exchange routing to a quorum queue that dead-letters into a fanout. */
export const SAMPLE_VHOST: FakeVhost = {
  exchanges: [
    { name: 'orders', type: 'topic' },
    { name: 'orders.dlx', type: 'fanout' },
  ],
  queues: [
    {
      name: 'orders.q',
      type: 'quorum',
      arguments: {
        'x-queue-type': 'quorum',
        'x-dead-letter-exchange': 'orders.dlx',
      },
      policy: null,
      operator_policy: null,
      delivery_limit: 20,
    },
    {
      name: 'orders.dlq',
      type: 'quorum',
      arguments: { 'x-queue-type': 'quorum' },
      policy: null,
      operator_policy: null,
      delivery_limit: 20,
    },
  ],
  bindings: [
    {
      source: 'orders',
      destination: 'orders.q',
      routing_key: 'order.*',
    },
    { source: 'orders.dlx', destination: 'orders.dlq' },
  ],
  policies: [],
  operatorPolicies: [],
  consumers: {},
};

const BROKER_PAGE_CEILING = 500;

/** The errors the scheduled port throws for the three refusals (spec R1 reads them as gaps). */
export function refusalError(refusal: Refusal): AppError {
  const [code, status]: [ErrorCode, number] =
    refusal === 'forbidden'
      ? ['FORBIDDEN_BROKER', 403]
      : refusal === 'not-found'
        ? ['NOT_FOUND', 404]
        : ['BROKER_ERROR', 405];
  return new AppError(code, {
    detail: 'The management API refused the read.',
    broker: { protocol: 'http', code: status },
  });
}

/** A management failure as the scheduled port throws it, with broker text no answer may carry. */
export function brokerFailure(status = 503): AppError {
  return new AppError('BROKER_UNREACHABLE', {
    detail: 'secret-broker-text',
    retryable: true,
    broker: { protocol: 'http', code: status, text: 'secret-broker-text' },
  });
}

/**
 * A management API over the described vhosts. `/api/queues/{vhost}` and `/api/exchanges/{vhost}`
 * answer the paged envelope (ceiling 500); `/api/bindings/{vhost}`, `/api/policies/{vhost}`,
 * `/api/operator-policies/{vhost}` and `/api/consumers/{vhost}` answer a bare array, as RabbitMQ
 * does; a vhost that is not described answers 404.
 */
export function createScriptedBroker(
  vhosts: Readonly<Record<string, FakeVhost>>,
): ScriptedBroker {
  const requests: RecordedRequest[] = [];
  const envelope = (
    query: MgmtGetRequest<unknown>['query'],
    all: readonly unknown[],
  ) => {
    const pageSize = Math.min(
      Number(query?.page_size ?? BROKER_PAGE_CEILING),
      BROKER_PAGE_CEILING,
    );
    const page = Number(query?.page ?? 1);
    const items = all.slice((page - 1) * pageSize, page * pageSize);
    return {
      items,
      page,
      page_size: pageSize,
      page_count: Math.max(1, Math.ceil(all.length / pageSize)),
      total_count: all.length,
    };
  };
  const policyRow = (policy: FakePolicy) => ({
    'apply-to': 'all',
    priority: 0,
    ...policy,
  });

  const broker: ScriptedBroker = {
    read: {
      get<T>(request: MgmtGetRequest<T>): Promise<T> {
        const recorded = {
          path: request.path,
          query: request.query ?? {},
          lane: request.lane,
        };
        requests.push(recorded);
        const failure = broker.intercept?.(recorded, requests.length);
        if (failure) return Promise.reject(failure);
        const [, , kind, rawVhost] = request.path.split('/');
        const vhost = decodeURIComponent(rawVhost ?? '');
        const description = vhosts[vhost];
        if (description === undefined) {
          return Promise.reject(refusalError('not-found'));
        }
        const listed = (
          list: readonly FakePolicy[] | Refusal | undefined,
        ): Promise<T> => {
          if (typeof list === 'string') {
            return Promise.reject(refusalError(list));
          }
          return Promise.resolve(
            request.schema.parse((list ?? []).map(policyRow)),
          );
        };
        switch (kind) {
          case 'queues':
            return Promise.resolve(
              request.schema.parse(
                envelope(request.query, description.queues ?? []),
              ),
            );
          case 'exchanges':
            return Promise.resolve(
              request.schema.parse(
                envelope(
                  request.query,
                  (description.exchanges ?? []).map((x) => ({
                    type: 'direct',
                    ...x,
                  })),
                ),
              ),
            );
          case 'bindings':
            return Promise.resolve(
              request.schema.parse(
                (description.bindings ?? []).map((b) => ({
                  destination_type: 'queue',
                  routing_key: '',
                  ...b,
                })),
              ),
            );
          case 'policies':
            return listed(description.policies);
          case 'operator-policies':
            return listed(description.operatorPolicies);
          case 'consumers': {
            const consumers = description.consumers ?? {};
            if (typeof consumers === 'string') {
              return Promise.reject(refusalError(consumers));
            }
            return Promise.resolve(
              request.schema.parse([
                ...(consumers.acking ?? []).map((name) => ({
                  queue: { name },
                  ack_required: true,
                })),
                ...(consumers.noAck ?? []).map((name) => ({
                  queue: { name },
                  ack_required: false,
                })),
              ]),
            );
          }
          default:
            return Promise.reject(refusalError('not-found'));
        }
      },
      stream: () =>
        Promise.reject(new Error('svc-topology never streams a body')),
    },
    requests,
  };
  return broker;
}

/** A probed profile with the fields of the schema and nothing planted in them. */
export function sampleProfile(
  overrides: Partial<BrokerProfile> = {},
): BrokerProfile {
  return BrokerProfileSchema.parse({
    schemaVersion: 1,
    connectionId: FAKE_CONNECTION_ID,
    probedAt: 1_700_000_000_000,
    fingerprint: 'fp-1',
    semanticsVersion: 'sem-test',
    product: 'rabbitmq',
    provider: 'self-hosted',
    versions: {
      min: { major: 4, minor: 3, patch: 6, raw: '4.3.6' },
      perNode: { 'rabbit@n0': { major: 4, minor: 3, patch: 6, raw: '4.3.6' } },
      mixed: false,
      build: 'oss',
    },
    era: { value: '4.3', reasons: [], conservative: false },
    verification: 'verified',
    lbFronted: { value: false, evidence: [] },
    nodes: [{ name: 'rabbit@n0', running: true }],
    identity: {
      user: 'guest',
      tags: ['administrator'],
      isAdmin: true,
      canMonitor: true,
      isPolicymaker: true,
    },
    featureFlags: {},
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
    limits: { preAuthFrameMax: 4096 },
    prometheus: {
      endpoints: [],
      perObjectAllowed: true,
      queueFilter: true,
      minIntervalSec: 15,
    },
    streams: {
      supported: true,
      paths: ['amqp091'],
      streamProtocolReachable: 'unknown',
    },
    firehose: { available: 'none' },
    auth: { httpChainSeparate: 'unknown' },
    tls: { verified: true, insecureOverride: false },
    managedObjects: [],
    hazards: [],
    gates: {},
    ...overrides,
  });
}

export interface TopologyFakeDeps extends TopologyModuleDeps, ActionDeps {
  readonly broker: ScriptedBroker;
  readonly clock: ManualClock;
  /** Turns of the event loop the module asked for (specs count them instead of timing them). */
  readonly yields: { count: number };
}

export function createTopologyFakeDeps(
  options: {
    /** The vhosts the broker holds; default one vhost `/` with `SAMPLE_VHOST`. */
    vhosts?: Readonly<Record<string, FakeVhost>>;
    ownerId?: string;
    /** The connection has a cached profile, as after a probe (default true). */
    seeded?: boolean;
    profile?: Partial<BrokerProfile>;
    /** Replaces the scripted broker as the engine's management port. */
    mgmt?: MgmtReadPort;
    limits?: Partial<TopologyLimits>;
  } = {},
): TopologyFakeDeps {
  const broker = createScriptedBroker(options.vhosts ?? { '/': SAMPLE_VHOST });
  const clock = createManualClock();
  const profile = sampleProfile(options.profile);
  const yields = { count: 0 };
  const connection = {
    id: FAKE_CONNECTION_ID,
    name: 'Fake broker',
    envClass: 'dev',
    color: null,
    config: {},
    ownerId: options.ownerId ?? 'user-1',
    visibility: 'private' as const,
    createdAt: 1_000,
    updatedAt: 1_000,
  };
  const mgmt = options.mgmt ?? broker.read;
  return {
    broker,
    mgmt,
    clock,
    yields,
    snapshots: createSnapshotReader({ mgmt, clock, limits: options.limits }),
    yieldNow: () => {
      yields.count += 1;
      return Promise.resolve();
    },
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    profiles: {
      get: (id) =>
        Promise.resolve(
          options.seeded === false || id !== FAKE_CONNECTION_ID
            ? undefined
            : {
                connectionId: id,
                fingerprint: profile.fingerprint,
                verification: profile.verification,
                probedAt: profile.probedAt,
                profile,
              },
        ),
    },
    connections: {
      get: (id) =>
        Promise.resolve(id === FAKE_CONNECTION_ID ? connection : undefined),
    },
  };
}
