// Fakes for the ports of this module, shared by its specs, by the architecture manifest
// (tools/arch-tests) and by the HTTP specs (libs/testkit).
import { BrokerProfileSchema, type BrokerProfile } from '@app/domain-model';
import {
  createManualClock,
  createManualTimers,
  type ManualClock,
  type ManualTimers,
} from '@app/kernel';
import type { Lane, MgmtGetRequest, MgmtReadPort } from '@app/ports';

import type { ExplorerLimits, ExplorerModuleDeps } from './deps';
import { createBindingsStore, type BindingsStore } from './internal/bindings';
import { createSweeper, type Sweeper } from './internal/sweeper';

/** The connection every fake starts with: owned by the test principal (`user-1`). */
export const FAKE_CONNECTION_ID = 'c1';

/** One management request, as the scripted broker saw it. */
export interface RecordedRequest {
  readonly path: string;
  readonly query: Readonly<Record<string, string | number | boolean>>;
  readonly lane: Lane;
}

export interface ScriptedBroker {
  /** The read port a module is given. */
  readonly read: MgmtReadPort;
  /** Every request, in order. */
  readonly requests: RecordedRequest[];
  /** The vhosts the broker holds, in the order `/api/vhosts` lists them. */
  readonly vhosts: readonly string[];
  readonly queueCount: number;
  /**
   * Called with every request and its 1-based ordinal before it is answered: return an error to
   * fail it (its text is broker text, which no output may carry). Settable by a spec.
   */
  intercept?:
    | ((request: RecordedRequest, ordinal: number) => Error | undefined)
    | undefined;
}

/** The broker's own page ceiling. */
const BROKER_MAX_PAGE_SIZE = 500;

/** A management failure as the scheduled port throws it. */
export function brokerFailure(status = 503): Error {
  return Object.assign(new Error(`HTTP ${String(status)} secret-broker-text`), {
    code: 'BROKER_UNREACHABLE',
    broker: { protocol: 'http', code: status },
  });
}

/**
 * A management API with `queueCount` queues spread evenly across `vhostCount` vhosts (and
 * `exchangesPerVhost` exchanges in each). `/api/queues` (all vhosts), `/api/queues/{vhost}` and
 * `/api/exchanges/{vhost}` answer the paged envelope (`page`, `page_size`, ceiling 500);
 * `/api/vhosts` answers a bare array; `/api/overview`, `/api/nodes` and `/api/health/checks/alarms`
 * answer a statistics-off single node; every other path answers 404, like a broker without the
 * endpoint. Every request is recorded.
 */
export function createScriptedBroker(
  options: {
    queueCount?: number;
    vhostCount?: number;
    exchangesPerVhost?: number;
    /** Bindings in every vhost (a number), or in the named vhosts (a record; the others hold none). */
    bindingsPerVhost?: number | Readonly<Record<string, number>>;
    /** `bare`: `/api/bindings/{vhost}` answers every binding as a bare array, as RabbitMQ does (default `paged`). */
    bindingsAnswer?: 'paged' | 'bare';
  } = {},
): ScriptedBroker {
  const queueCount = options.queueCount ?? 0;
  const vhostCount = Math.max(1, options.vhostCount ?? 1);
  const exchangeCount = options.exchangesPerVhost ?? 0;
  const bindingCount = (vhost: string): number =>
    typeof options.bindingsPerVhost === 'number'
      ? options.bindingsPerVhost
      : (options.bindingsPerVhost?.[vhost] ?? 0);
  const vhosts = Array.from({ length: vhostCount }, (_, i) =>
    i === 0 ? '/' : `vhost-${String(i)}`,
  );
  const queue = (i: number) => ({
    name: `queue-${String(i).padStart(6, '0')}`,
    vhost: vhosts[i % vhostCount],
    type: 'classic',
    durable: true,
    messages: i % 100,
  });
  const requests: RecordedRequest[] = [];

  const paged = <T>(
    request: MgmtGetRequest<T>,
    total: number,
    item: (i: number) => unknown,
  ): T => {
    const query = request.query ?? {};
    const pageSize = Math.min(
      Number(query.page_size ?? BROKER_MAX_PAGE_SIZE),
      BROKER_MAX_PAGE_SIZE,
    );
    const page = Number(query.page ?? 1);
    const from = (page - 1) * pageSize;
    const items = Array.from(
      { length: Math.max(0, Math.min(pageSize, total - from)) },
      (_, i) => item(from + i),
    );
    return request.schema.parse({
      items,
      page,
      page_size: pageSize,
      page_count: Math.max(1, Math.ceil(total / pageSize)),
      total_count: total,
      filtered_count: total,
      item_count: items.length,
    });
  };

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
        const vhost =
          rawVhost === undefined ? '' : decodeURIComponent(rawVhost);
        const at = vhosts.indexOf(vhost);
        if (request.path === '/api/vhosts') {
          return Promise.resolve(
            request.schema.parse(vhosts.map((name) => ({ name }))),
          );
        }
        // The cluster reads of overview.get: a statistics-off single node with no alarm.
        if (request.path === '/api/overview') {
          return Promise.resolve(
            request.schema.parse({
              product_name: 'RabbitMQ',
              product_version: '4.2.9',
              cluster_name: 'rabbit@fake',
              disable_stats: true,
              object_totals: {
                queues: queueCount,
                exchanges: exchangeCount * vhostCount,
                connections: 0,
              },
            }),
          );
        }
        if (request.path === '/api/nodes') {
          return Promise.resolve(
            request.schema.parse([
              { name: 'rabbit@fake', running: true, being_drained: false },
            ]),
          );
        }
        if (request.path === '/api/health/checks/alarms') {
          return Promise.resolve(request.schema.parse({ status: 'ok' }));
        }
        if (request.path === '/api/queues') {
          return Promise.resolve(paged(request, queueCount, queue));
        }
        if (at >= 0 && kind === 'queues') {
          const own = Math.max(0, Math.ceil((queueCount - at) / vhostCount));
          return Promise.resolve(
            paged(request, own, (j) => queue(at + j * vhostCount)),
          );
        }
        if (at >= 0 && kind === 'exchanges') {
          return Promise.resolve(
            paged(request, exchangeCount, (j) => ({
              name: `exchange-${String(j)}`,
              vhost,
              type: 'direct',
              durable: true,
            })),
          );
        }
        if (at >= 0 && kind === 'bindings') {
          const binding = (j: number) => ({
            source: `exchange-${String(j % 10)}`,
            vhost,
            destination: `queue-${String(j).padStart(6, '0')}`,
            destination_type: 'queue',
            routing_key: `rk-${String(j)}`,
            properties_key: `rk-${String(j)}`,
            arguments: {},
          });
          // RabbitMQ ignores `page` here and sends every binding of the vhost as a bare array.
          if (options.bindingsAnswer === 'bare') {
            return Promise.resolve(
              request.schema.parse(
                Array.from({ length: bindingCount(vhost) }, (_, j) =>
                  binding(j),
                ),
              ),
            );
          }
          return Promise.resolve(paged(request, bindingCount(vhost), binding));
        }
        return Promise.reject(
          Object.assign(new Error('NOT_FOUND: HTTP 404'), {
            code: 'NOT_FOUND',
            broker: { protocol: 'http', code: 404 },
          }),
        );
      },
      stream: () => Promise.reject(new Error('the explorer never streams')),
    },
    requests,
    vhosts,
    queueCount,
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
    stats: { disabled: true, queueTotals: true },
    classicEnabled: true,
    exchangeTypes: ['direct'],
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

export interface ExplorerFakeDeps extends ExplorerModuleDeps {
  readonly broker: ScriptedBroker;
  /** The sweeper over `mgmt`, on manual time: its timers never fire unless a spec advances them. */
  readonly sweeper: Sweeper;
  /** The per-vhost bindings store over mgmt, on the same manual clock. */
  readonly bindings: BindingsStore;
  readonly clock: ManualClock;
  readonly timers: ManualTimers;
}

export function createExplorerFakeDeps(
  options: {
    ownerId?: string;
    queueCount?: number;
    vhostCount?: number;
    exchangesPerVhost?: number;
    bindingsPerVhost?: number | Readonly<Record<string, number>>;
    bindingsAnswer?: 'paged' | 'bare';
    /** The connection has a cached profile, as after a probe (default true). */
    seeded?: boolean;
    profile?: Partial<BrokerProfile>;
    /** Replaces the scripted broker as the engine's management port. */
    mgmt?: MgmtReadPort;
    limits?: Partial<ExplorerLimits>;
  } = {},
): ExplorerFakeDeps {
  const broker = createScriptedBroker(options);
  const clock = createManualClock();
  const timers = createManualTimers(clock);
  const profile = sampleProfile(options.profile);
  const mgmt = options.mgmt ?? broker.read;
  const limits = options.limits === undefined ? {} : { limits: options.limits };
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
  return {
    broker,
    mgmt,
    clock,
    timers,
    ...limits,
    sweeper: createSweeper({ mgmt, clock, timers, ...limits }),
    bindings: createBindingsStore({ mgmt, clock, ...limits }),
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
