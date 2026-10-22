// Fakes for the ports of this module, shared by its specs, by the architecture manifest
// (tools/arch-tests) and by the HTTP specs (libs/testkit): a scripted Prometheus endpoint, a
// scripted management API, a stored connection and profile, and a manual clock.
import { BrokerProfileSchema, type BrokerProfile } from '@app/domain-model';
import {
  AppError,
  createManualClock,
  createManualTimers,
  type ManualClock,
  type ManualTimers,
} from '@app/kernel';
import type {
  MgmtGetRequest,
  MgmtReadPort,
  PromReadPort,
  PromSample,
  PromScrapeRequest,
} from '@app/ports';

import type {
  MetricsActionDeps,
  MetricsLimits,
  MetricsModuleDeps,
} from './deps';
import { createCollector } from './internal/collector';

/** The connection every fake starts with: owned by the test principal (`user-1`). */
export const FAKE_CONNECTION_ID = 'c1';

/** A probed profile with one node and one listener; override what a spec changes. */
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
      perNode: { 'rabbit@n1': { major: 4, minor: 3, patch: 6, raw: '4.3.6' } },
      mixed: false,
      build: 'oss',
    },
    era: { value: '4.3', reasons: [], conservative: false },
    verification: 'verified',
    lbFronted: { value: false, evidence: [] },
    nodes: [{ name: 'rabbit@n1', running: true }],
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
    exchangeTypes: ['direct'],
    extensions: [],
    restrictions: {
      operatorPolicyChanges: 'allowed',
      qqReplicaOps: 'allowed',
      definitionsExport: 'full',
    },
    limits: { preAuthFrameMax: 4096 },
    prometheus: {
      endpoints: [
        {
          node: 'rabbit@n1',
          url: 'http://127.0.0.1:15692/metrics',
          source: 'listener',
        },
      ],
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

/** A queue the scripted broker holds. */
export interface ScriptedQueue {
  readonly vhost: string;
  readonly name: string;
  readonly ready: number;
  readonly unacked: number;
  readonly consumers: number;
}

export interface ScriptedProm {
  readonly read: PromReadPort;
  readonly requests: PromScrapeRequest[];
  /** The scrape rounds served so far (aggregated pages). */
  rounds: number;
  /** Queues the detailed page lists; a spec replaces it. */
  queues: ScriptedQueue[];
  /** Makes a request fail instead of answering; return an Error. Settable by a spec. */
  intercept?: ((request: PromScrapeRequest) => Error | undefined) | undefined;
  /** The cluster messages ready of round `n` (1-based). Settable by a spec. */
  ready: (round: number) => number;
}

/** A management failure as the scheduled port throws it. */
export function brokerFailure(status = 503): Error {
  return Object.assign(new Error(`HTTP ${String(status)} secret-broker-text`), {
    code: 'BROKER_UNREACHABLE',
    broker: { protocol: 'http', code: status },
  });
}

const sample = (
  name: string,
  value: number,
  labels: Record<string, string> = {},
): PromSample => ({ name, labels, value });

export function createScriptedProm(): ScriptedProm {
  const script: ScriptedProm = {
    requests: [],
    rounds: 0,
    queues: [
      { vhost: '/', name: 'orders', ready: 120, unacked: 4, consumers: 2 },
      { vhost: '/', name: 'audit', ready: 5, unacked: 0, consumers: 0 },
    ],
    ready: (round) => 1_000 - 10 * round,
    read: {
      read(request, sink, options, signal) {
        signal.throwIfAborted();
        script.requests.push(request);
        const failure = script.intercept?.(request);
        if (failure !== undefined) return Promise.reject(failure);
        const wanted = options.wanted ?? (() => true);
        let delivered = 0;
        const deliver = (item: PromSample): void => {
          if (wanted(item.name) && (options.accept?.(item) ?? true)) {
            sink(item);
            delivered++;
          }
        };
        if (request.path === '/metrics') {
          script.rounds++;
          const ready = script.ready(script.rounds);
          deliver(sample('rabbitmq_queue_messages_ready', ready));
          deliver(sample('rabbitmq_queue_messages_unacked', 7));
          deliver(sample('rabbitmq_queue_messages', ready + 7));
          deliver(sample('rabbitmq_connections', 3));
          deliver(
            sample(
              'rabbitmq_channel_messages_published_total',
              script.rounds * 100,
            ),
          );
          deliver(sample('rabbitmq_process_resident_memory_bytes', 2e8));
          deliver(sample('rabbitmq_disk_space_available_bytes', 9e11));
          deliver(sample('erlang_vm_dist_recv_bytes', 1));
        } else {
          const vhost = request.query?.vhost;
          for (const queue of script.queues) {
            if (typeof vhost === 'string' && queue.vhost !== vhost) continue;
            const labels = { vhost: queue.vhost, queue: queue.name };
            deliver(
              sample(
                'rabbitmq_detailed_queue_messages_ready',
                queue.ready,
                labels,
              ),
            );
            deliver(
              sample(
                'rabbitmq_detailed_queue_messages_unacked',
                queue.unacked,
                labels,
              ),
            );
            deliver(
              sample(
                'rabbitmq_detailed_queue_messages',
                queue.ready + queue.unacked,
                labels,
              ),
            );
            deliver(
              sample(
                'rabbitmq_detailed_queue_consumers',
                queue.consumers,
                labels,
              ),
            );
            deliver(
              sample('rabbitmq_detailed_queue_info', 1, {
                ...labels,
                membership: 'leader',
              }),
            );
          }
        }
        return Promise.resolve({
          bytes: delivered * 60,
          samples: delivered,
          skipped: 0,
          malformed: 0,
          oversizedLines: 0,
        });
      },
    },
  };
  return script;
}

export interface ScriptedMgmt {
  readonly read: MgmtReadPort;
  readonly paths: string[];
  /** Replaces an answer; return an Error to fail it. Settable by a spec. */
  answer?: ((path: string) => unknown) | undefined;
  statsOff: boolean;
}

export function createScriptedMgmt(): ScriptedMgmt {
  const script: ScriptedMgmt = {
    paths: [],
    statsOff: false,
    read: {
      async get<T>(request: MgmtGetRequest<T>): Promise<T> {
        await Promise.resolve();
        script.paths.push(request.path);
        const scripted = script.answer?.(request.path);
        if (scripted instanceof Error) throw scripted;
        if (scripted !== undefined) return request.schema.parse(scripted);
        if (request.path === '/api/overview') {
          return request.schema.parse(
            script.statsOff
              ? { object_totals: { connections: 3, queues: 2 } }
              : {
                  queue_totals: {
                    messages: 900,
                    messages_ready: 890,
                    messages_unacknowledged: 10,
                  },
                  object_totals: {
                    connections: 3,
                    channels: 4,
                    consumers: 2,
                    queues: 2,
                  },
                  message_stats: {
                    publish: 5000,
                    deliver_get: 4000,
                    ack: 3900,
                    redeliver: 12,
                  },
                },
          );
        }
        if (request.path === '/api/nodes') {
          return request.schema.parse([
            {
              name: 'rabbit@n1',
              mem_used: 3e8,
              mem_limit: 8e9,
              disk_free: 8e11,
              disk_free_limit: 5e7,
            },
          ]);
        }
        if (request.path.startsWith('/api/queues/')) {
          return request.schema.parse({
            messages: 50,
            messages_ready: 45,
            messages_unacknowledged: 5,
            consumers: 1,
          });
        }
        throw Object.assign(new Error('NOT_FOUND: HTTP 404'), {
          code: 'NOT_FOUND',
          broker: { protocol: 'http', code: 404 },
        });
      },
      stream: () => Promise.reject(new AppError('INTERNAL')),
    },
  };
  return script;
}

export interface MetricsFakeDeps extends MetricsActionDeps {
  readonly clock: ManualClock;
  readonly timers: ManualTimers;
  readonly promScript: ScriptedProm;
  readonly mgmtScript: ScriptedMgmt;
}

export function createMetricsFakeDeps(
  options: {
    ownerId?: string;
    /** The connection has a cached profile, as after a probe (default true). */
    seeded?: boolean;
    profile?: Partial<BrokerProfile>;
    limits?: Partial<MetricsLimits>;
    /** Replaces the scripted Prometheus port (the golden replay passes the real reader). */
    prom?: PromReadPort;
    /** Replaces the scripted management port. */
    mgmt?: MgmtReadPort;
  } = {},
): MetricsFakeDeps {
  const clock = createManualClock(1_700_000_000_000);
  const timers = createManualTimers(clock);
  const promScript = createScriptedProm();
  const mgmtScript = createScriptedMgmt();
  const profile = sampleProfile(options.profile);
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
  const deps: MetricsModuleDeps = {
    clock,
    timers,
    prom: options.prom ?? promScript.read,
    mgmt: options.mgmt ?? mgmtScript.read,
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
  return {
    ...deps,
    collector: createCollector(deps),
    clock,
    timers,
    promScript,
    mgmtScript,
  };
}
