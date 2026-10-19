// Fakes for the ports of this module, shared by its specs, by the architecture manifest
// (tools/arch-tests) and by the HTTP specs (libs/testkit).
import type {
  AmqpHandshakeResult,
  BrokerProfileRecord,
  BrokerProfileStore,
  BrokerWireProbe,
  ConnectionRecord,
  MgmtGetRequest,
  MgmtReadPort,
  MgmtStreamRequest,
  TlsProbeResult,
  WireTarget,
} from '@app/ports';

import { ConnectionIdSchema } from '@app/contracts';
import type { BrokerProfile } from '@app/domain-model';
import { semanticsRegistry } from '@app/semantics';

import type { CapabilitiesModuleDeps } from './deps';
import { buildProfile } from './profile-builder';

/** What a management request was, as the fake saw it. */
export interface RecordedRequest {
  readonly method: 'GET' | 'PUT' | 'POST' | 'DELETE';
  readonly path: string;
  readonly query: Readonly<Record<string, string | number | boolean>>;
}

/**
 * An error shaped like the management adapter's `MgmtHttpError` (`code`, and `broker.code` for the
 * HTTP status): a service may not import the adapter, so it reads those two fields only.
 */
export function brokerError(status: number): Error {
  const code =
    status === 401
      ? 'UNAUTHENTICATED'
      : status === 403
        ? 'FORBIDDEN_BROKER'
        : status === 404
          ? 'NOT_FOUND'
          : status === 503
            ? 'BROKER_UNREACHABLE'
            : 'BROKER_ERROR';
  return Object.assign(new Error(`${code}: HTTP ${String(status)}`), {
    code,
    broker: { protocol: 'http', code: status },
  });
}

/**
 * A route answers a value (parsed with the request's schema), throws the Error it is, or, when it is a
 * function, answers what that returns for the call count (1 for the first request of the path).
 */
export type Route = unknown;

export interface ScriptedMgmt {
  /** The read port a module is given. */
  readonly read: MgmtReadPort;
  /**
   * Every request the fake saw, reads and any write attempt alike. `write` is not part of what the
   * module is given: it exists so a spec can prove nothing ever asked for it.
   */
  readonly requests: RecordedRequest[];
  /** Replaces the answer of a path (a value, an Error, or a function of the call count). */
  route(path: string, answer: Route): void;
  readonly write: { send(...args: unknown[]): never };
}

/**
 * A management API that answers from a table by path. A path with no route answers 404, like a
 * broker without the endpoint. A `string` route is the body of a text answer (`stream`).
 */
export function createScriptedMgmt(
  routes: Readonly<Record<string, Route>> = {},
): ScriptedMgmt {
  const table = new Map<string, Route>(Object.entries(routes));
  const calls = new Map<string, number>();
  const requests: RecordedRequest[] = [];

  const answer = (path: string): unknown => {
    const count = (calls.get(path) ?? 0) + 1;
    calls.set(path, count);
    const route = table.get(path);
    if (route === undefined) throw brokerError(404);
    const value =
      typeof route === 'function'
        ? (route as (n: number) => Route)(count)
        : route;
    if (value instanceof Error) throw value;
    return value;
  };

  const read: MgmtReadPort = {
    get<T>(request: MgmtGetRequest<T>): Promise<T> {
      requests.push({
        method: 'GET',
        path: request.path,
        query: request.query ?? {},
      });
      try {
        return Promise.resolve(request.schema.parse(answer(request.path)));
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : brokerError(500),
        );
      }
    },
    stream(request: MgmtStreamRequest) {
      requests.push({
        method: 'GET',
        path: request.path,
        query: request.query ?? {},
      });
      try {
        const body = answer(request.path);
        const text = typeof body === 'string' ? body : JSON.stringify(body);
        return Promise.resolve(
          (async function* chunks() {
            await Promise.resolve();
            yield new TextEncoder().encode(text);
          })(),
        );
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : brokerError(500),
        );
      }
    },
  };

  return {
    read,
    requests,
    route: (path, value) => {
      table.set(path, value);
      calls.delete(path);
    },
    write: {
      send: (...args: unknown[]): never => {
        requests.push({ method: 'POST', path: String(args[0]), query: {} });
        throw new Error('the probe must never write');
      },
    },
  };
}

export interface FakeWire extends BrokerWireProbe {
  target: WireTarget | undefined;
  tlsResult: TlsProbeResult;
  amqpResult: AmqpHandshakeResult;
  readonly calls: string[];
}

export function createFakeWire(): FakeWire {
  const wire: FakeWire = {
    target: { host: 'mq.example', managementTls: false },
    tlsResult: { kind: 'plain' },
    amqpResult: { ok: true },
    calls: [],
    describe: () => {
      wire.calls.push('describe');
      return Promise.resolve(wire.target);
    },
    tls: () => {
      wire.calls.push('tls');
      return Promise.resolve(wire.tlsResult);
    },
    amqpHandshake: () => {
      wire.calls.push('amqpHandshake');
      return Promise.resolve(wire.amqpResult);
    },
  };
  return wire;
}

export function createMemoryProfileStore(): BrokerProfileStore & {
  readonly rows: Map<string, BrokerProfileRecord>;
} {
  const rows = new Map<string, BrokerProfileRecord>();
  return {
    rows,
    get: (id) => Promise.resolve(rows.get(id)),
    put: (record) => {
      rows.set(record.connectionId, record);
      return Promise.resolve();
    },
    delete: (id) => Promise.resolve(rows.delete(id)),
  };
}

/** The connection every fake starts with: owned by the test principal (`user-1`). */
export const FAKE_CONNECTION_ID = 'c1';

const fakeConnection = (ownerId: string): ConnectionRecord => ({
  id: FAKE_CONNECTION_ID,
  name: 'Fake broker',
  envClass: 'dev',
  color: null,
  config: {},
  ownerId,
  visibility: 'private',
  createdAt: 1_000,
  updatedAt: 1_000,
});

export interface CapabilitiesFakeDeps extends CapabilitiesModuleDeps {
  readonly scripted: ScriptedMgmt;
  readonly wire: FakeWire;
  readonly profiles: ReturnType<typeof createMemoryProfileStore>;
}

/** A small, healthy single-node RabbitMQ 4.3.6 for specs that do not care about the details. */
export const MINIMAL_BROKER: Readonly<Record<string, Route>> = {
  '/api/overview': {
    node: 'rabbit@a',
    product_name: 'RabbitMQ',
    rabbitmq_version: '4.3.6',
    disable_stats: false,
    listeners: [{ protocol: 'http', port: 15672 }],
  },
  '/api/whoami': { name: 'guest', tags: ['administrator'] },
  '/api/extensions': [],
  '/api/nodes': [{ name: 'rabbit@a', running: true }],
  '/api/feature-flags': [{ name: 'rabbitmq_4.3.0', state: 'enabled' }],
  '/api/deprecated-features/used': [],
  '/api/policies': [],
  '/api/operator-policies': [],
  '/api/users': [{ name: 'guest' }],
};

/** The profile of a single-node RabbitMQ 4.3.6, built without a broker, for specs of the readers. */
export function sampleProfile(): BrokerProfile {
  const overview = {
    node: 'rabbit@a',
    product_name: 'RabbitMQ',
    rabbitmq_version: '4.3.6',
    disable_stats: false,
  };
  return buildProfile({
    connectionId: ConnectionIdSchema.parse(FAKE_CONNECTION_ID),
    probedAt: 1_000,
    registry: semanticsRegistry,
    lastVerified: [],
    facts: {
      overviews: [{ node: 'rabbit@a', overview }],
      identity: { user: 'guest', tags: ['administrator'] },
      nodes: [
        {
          name: 'rabbit@a',
          running: true,
          beingDrained: undefined,
          plugins: undefined,
        },
      ],
      featureFlags: { 'rabbitmq_4.3.0': 'enabled' },
    },
  });
}

export function createCapabilitiesFakeDeps(
  options: {
    ownerId?: string;
    routes?: Readonly<Record<string, Route>>;
    /** Start with a cached profile for the fake connection, as after a probe. */
    seeded?: boolean;
  } = {},
): CapabilitiesFakeDeps {
  const scripted = createScriptedMgmt(options.routes ?? MINIMAL_BROKER);
  const connections = new Map([
    [FAKE_CONNECTION_ID, fakeConnection(options.ownerId ?? 'user-1')],
  ]);
  const profiles = createMemoryProfileStore();
  if (options.seeded === true) {
    const profile = sampleProfile();
    profiles.rows.set(FAKE_CONNECTION_ID, {
      connectionId: FAKE_CONNECTION_ID,
      fingerprint: profile.fingerprint,
      verification: profile.verification,
      probedAt: profile.probedAt,
      profile,
    });
  }
  return {
    scripted,
    mgmt: scripted.read,
    wire: createFakeWire(),
    profiles,
    connections: { get: (id) => Promise.resolve(connections.get(id)) },
  };
}
