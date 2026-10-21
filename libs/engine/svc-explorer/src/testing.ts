// Fakes for the ports of this module, shared by its specs, by the architecture manifest
// (tools/arch-tests) and by the HTTP specs (libs/testkit).
import { BrokerProfileSchema, type BrokerProfile } from '@app/domain-model';
import {
  createManualClock,
  createManualTimers,
  type ManualClock,
  type ManualTimers,
} from '@app/kernel';
import type {
  Lane,
  MgmtGetRequest,
  MgmtReadPort,
  MgmtStreamRequest,
} from '@app/ports';

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
  /** `get`: a parsed answer; `stream`: a body read as chunks. */
  readonly via: 'get' | 'stream';
}

/** One streamed answer, from the moment the scripted broker handed it out. */
export interface RecordedStream {
  readonly request: RecordedRequest;
  /** Bytes of the chunks the reader has taken. */
  bytesSent: number;
  /** The body was read to its end. */
  ended: boolean;
  /** The reader stopped before the end (a `break`, an error or an abort). */
  cancelled: boolean;
  /** Handed out and neither ended nor cancelled. */
  open: boolean;
}

/** What `/api/bindings/{vhost}` answers when a spec scripts it: bytes, a text or chunks. */
export type ScriptedBody = string | Uint8Array | AsyncIterable<Uint8Array>;

export interface ScriptedBroker {
  /** The read port a module is given. */
  readonly read: MgmtReadPort;
  /** Every request, in order. */
  readonly requests: RecordedRequest[];
  /** Every streamed answer, in order. */
  readonly streams: RecordedStream[];
  /** The most streams that were open at the same time. */
  maxOpenStreams: number;
  /**
   * Replaces the body of a `/api/bindings/{vhost}` stream for any vhost (return `undefined` for the
   * default). Settable by a spec.
   */
  bindingsBody?:
    | ((request: RecordedRequest, ordinal: number) => ScriptedBody | undefined)
    | undefined;
  /** The vhosts the broker holds, in the order `/api/vhosts` lists them. */
  readonly vhosts: readonly string[];
  readonly queueCount: number;
  readonly connectionCount: number;
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

/** A path the scripted broker does not serve, like a broker without the endpoint. */
function notFound(): Error {
  return Object.assign(new Error('NOT_FOUND: HTTP 404'), {
    code: 'NOT_FOUND',
    broker: { protocol: 'http', code: 404 },
  });
}

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
 * `/api/exchanges/{vhost}` answer the paged envelope (`page`, `page_size`, ceiling 500), and so does
 * `/api/connections` (all vhosts, `connectionCount` connections across the vhosts);
 * `/api/vhosts` answers a bare array; `/api/overview`, `/api/nodes` and `/api/health/checks/alarms`
 * answer a statistics-off single node; every other path answers 404, like a broker without the
 * endpoint. `/api/bindings/{vhost}` is answered by `stream` only (a bare array or the paged envelope,
 * in chunks of `bindingsChunkBytes`, or the body a spec scripts with `bindingsBody`); `get` of it is
 * a 404, so a reader that still used `get` would fail. Every request and every stream is recorded.
 */
export function createScriptedBroker(
  options: {
    queueCount?: number;
    vhostCount?: number;
    exchangesPerVhost?: number;
    /** Connections across all vhosts (default none). */
    connectionCount?: number;
    /** Bindings in every vhost (a number), or in the named vhosts (a record; the others hold none). */
    bindingsPerVhost?: number | Readonly<Record<string, number>>;
    /** `bare`: `/api/bindings/{vhost}` answers every binding as a bare array, as RabbitMQ does (default `paged`). */
    bindingsAnswer?: 'paged' | 'bare';
    /** Bytes of each chunk of a streamed bindings answer (default 4096). */
    bindingsChunkBytes?: number;
  } = {},
): ScriptedBroker {
  const queueCount = options.queueCount ?? 0;
  const connectionCount = options.connectionCount ?? 0;
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
  const connection = (i: number) => ({
    name: `connection-${String(i).padStart(6, '0')}`,
    vhost: vhosts[i % vhostCount],
    user: i % 2 === 0 ? 'guest' : 'app',
    node: 'rabbit@fake',
    state: i % 4 === 0 ? 'blocked' : 'running',
    protocol: i % 3 === 0 ? 'AMQP 1.0' : 'AMQP 0-9-1',
    channels: i % 5,
    peer_host: `192.0.2.${String((i % 250) + 1)}`,
    ssl: i % 7 === 0,
  });
  const requests: RecordedRequest[] = [];
  const streams: RecordedStream[] = [];
  const encoder = new TextEncoder();

  /** The paged envelope of one page of `total` items. */
  const envelope = (
    query: MgmtGetRequest<unknown>['query'],
    total: number,
    item: (i: number) => unknown,
  ) => {
    const pageSize = Math.min(
      Number(query?.page_size ?? BROKER_MAX_PAGE_SIZE),
      BROKER_MAX_PAGE_SIZE,
    );
    const page = Number(query?.page ?? 1);
    const from = (page - 1) * pageSize;
    const items = Array.from(
      { length: Math.max(0, Math.min(pageSize, total - from)) },
      (_, i) => item(from + i),
    );
    return {
      items,
      page,
      page_size: pageSize,
      page_count: Math.max(1, Math.ceil(total / pageSize)),
      total_count: total,
      filtered_count: total,
      item_count: items.length,
    };
  };

  const paged = <T>(
    request: MgmtGetRequest<T>,
    total: number,
    item: (i: number) => unknown,
  ): T => request.schema.parse(envelope(request.query, total, item));

  /** Cuts a body into chunks; a spec's own chunks pass through as they are. */
  async function* chunked(body: Uint8Array): AsyncGenerator<Uint8Array> {
    const size = Math.max(1, options.bindingsChunkBytes ?? 4096);
    for (let at = 0; at < body.length; at += size) {
      yield await Promise.resolve(body.subarray(at, at + size));
    }
  }

  /** The chunks of `body`, with what the reader did to them written into `record`. */
  function recordStream(
    request: RecordedRequest,
    body: ScriptedBody,
  ): AsyncIterable<Uint8Array> {
    const source: AsyncIterable<Uint8Array> =
      typeof body === 'string'
        ? chunked(encoder.encode(body))
        : body instanceof Uint8Array
          ? chunked(body)
          : body;
    const record: RecordedStream = {
      request,
      bytesSent: 0,
      ended: false,
      cancelled: false,
      open: true,
    };
    streams.push(record);
    broker.maxOpenStreams = Math.max(
      broker.maxOpenStreams,
      streams.filter((s) => s.open).length,
    );
    const close = (): void => {
      record.open = false;
    };
    return {
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        const iterator = source[Symbol.asyncIterator]();
        return {
          async next() {
            try {
              const step = await iterator.next();
              if (step.done === true) {
                record.ended = true;
                close();
              } else record.bytesSent += step.value.length;
              return step;
            } catch (error) {
              record.cancelled = true;
              close();
              throw error;
            }
          },
          return(value?: unknown) {
            if (!record.ended) record.cancelled = true;
            close();
            return (
              iterator.return?.(value) ??
              Promise.resolve({ done: true as const, value: undefined })
            );
          },
        };
      },
    };
  }

  /** What the broker would send for `/api/bindings/{vhost}`: a bare array, or one page of the envelope. */
  function bindingsOf(
    request: RecordedRequest,
    vhost: string,
    at: number,
  ): ScriptedBody | undefined {
    const binding = (j: number) => ({
      source: `exchange-${String(j % 10)}`,
      vhost,
      destination: `queue-${String(j).padStart(6, '0')}`,
      destination_type: 'queue',
      routing_key: `rk-${String(j)}`,
      properties_key: `rk-${String(j)}`,
      arguments: {},
    });
    const scripted = broker.bindingsBody?.(request, requests.length);
    if (scripted !== undefined) return scripted;
    if (at < 0) return undefined;
    // RabbitMQ ignores `page` here and sends every binding of the vhost as a bare array.
    if (options.bindingsAnswer === 'bare') {
      return JSON.stringify(
        Array.from({ length: bindingCount(vhost) }, (_, j) => binding(j)),
      );
    }
    return JSON.stringify(
      envelope(request.query, bindingCount(vhost), binding),
    );
  }

  const broker: ScriptedBroker = {
    read: {
      get<T>(request: MgmtGetRequest<T>): Promise<T> {
        const recorded = {
          path: request.path,
          query: request.query ?? {},
          lane: request.lane,
          via: 'get' as const,
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
                connections: connectionCount,
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
        if (request.path === '/api/connections') {
          return Promise.resolve(paged(request, connectionCount, connection));
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
        return Promise.reject(notFound());
      },
      stream(request: MgmtStreamRequest): Promise<AsyncIterable<Uint8Array>> {
        const recorded = {
          path: request.path,
          query: request.query ?? {},
          lane: request.lane,
          via: 'stream' as const,
        };
        requests.push(recorded);
        const failure = broker.intercept?.(recorded, requests.length);
        if (failure) return Promise.reject(failure);
        const [, , kind, rawVhost] = request.path.split('/');
        if (kind !== 'bindings' || rawVhost === undefined) {
          return Promise.reject(new Error('the explorer never streams'));
        }
        const vhost = decodeURIComponent(rawVhost);
        const body = bindingsOf(recorded, vhost, vhosts.indexOf(vhost));
        return body === undefined
          ? Promise.reject(notFound())
          : Promise.resolve(recordStream(recorded, body));
      },
    },
    requests,
    streams,
    maxOpenStreams: 0,
    vhosts,
    queueCount,
    connectionCount,
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
    connectionCount?: number;
    bindingsPerVhost?: number | Readonly<Record<string, number>>;
    bindingsAnswer?: 'paged' | 'bare';
    bindingsChunkBytes?: number;
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
    bindings: createBindingsStore({ mgmt, clock, timers, ...limits }),
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
