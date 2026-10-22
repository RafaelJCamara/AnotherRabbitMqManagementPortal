// Test support for the composed engine with its services: a local-mode engine over a temporary
// SQLite file with an unlocked vault, a scripted broker behind fake ports (or the real adapters,
// when a spec passes `createBrokerPorts`), and a helper that calls the real router in process.
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createLogger } from '@app/kernel';
import type { Repositories } from '@app/persistence';
import {
  createFakeWire,
  createScriptedMgmt,
  MINIMAL_BROKER,
  type ScriptedMgmt,
} from '@app/svc-capabilities';
import { createFakeProber } from '@app/svc-connections';

import type { BrokerPortsFactory } from '../broker/index.ts';
import { composeEngine, type Engine } from '../compose-core.ts';
import { createLogTail } from '../log-tail.ts';
import { createLocalMode } from '../modes/local.ts';
import { coreModules } from '../modules/index.ts';
import { tempDir, type TempDir } from './harness.ts';

/** The principal id of the launch-token user: the owner of the connections a spec seeds. */
export const OWNER = 'local-token';

const log = createLogger({ level: 'silent' });
const made: TempDir[] = [];
const engines: Engine[] = [];

/** Closes every engine and removes every directory the specs of this file made. */
export async function closeAll(): Promise<void> {
  for (const engine of engines.splice(0)) await engine.close();
  for (const temp of made.splice(0)) await temp.cleanup();
}

export const page = (items: readonly unknown[]) => ({
  items,
  page: 1,
  page_size: 500,
  page_count: 1,
  total_count: items.length,
  filtered_count: items.length,
  item_count: items.length,
});

export const QUEUES = ['orders', 'payments', 'audit'].map((name, index) => ({
  name,
  vhost: '/',
  type: 'classic',
  durable: true,
  messages: index * 10,
}));

/** The answers of a broker the probe and the explorer can read: one vhost, three queues, no exchanges. */
export const BROKER_ROUTES: Readonly<Record<string, unknown>> = {
  ...MINIMAL_BROKER,
  '/api/overview': {
    node: 'rabbit@a',
    product_name: 'RabbitMQ',
    rabbitmq_version: '4.3.6',
    cluster_name: 'rabbit@a',
    disable_stats: false,
    object_totals: { queues: QUEUES.length, exchanges: 0, connections: 0 },
    listeners: [{ protocol: 'http', port: 15672 }],
  },
  '/api/vhosts': [{ name: '/' }],
  '/api/queues/%2F': page(QUEUES),
  '/api/exchanges/%2F': page([]),
  '/api/connections': page([]),
  '/api/health/checks/alarms': { status: 'ok' },
};

export const scriptedBroker = (): ScriptedMgmt =>
  createScriptedMgmt(BROKER_ROUTES);

/** The stored config of a profile that points at a management API on `port` (and AMQP on `amqpPort`). */
export const storedConfig = (port: number, amqpPort = 5672) => ({
  v: 1,
  http: {
    host: '127.0.0.1',
    port,
    tls: false,
    pathPrefix: null,
    auth: { kind: 'basic', username: 'guest' },
  },
  amqp: {
    host: '127.0.0.1',
    port: amqpPort,
    tls: false,
    vhost: '/',
    auth: { kind: 'plain', username: 'guest' },
  },
});

export interface Booted {
  readonly engine: Engine;
  readonly token: string;
  readonly repos: () => Repositories;
  readonly broker: ScriptedMgmt;
  /** What the composition root handed the factory of the broker ports (stores, vault cipher). */
  readonly input: () => Parameters<BrokerPortsFactory>[0];
  /** One request to the real router, in process, as the launch-token user. */
  call(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    payload?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  /** A connection owned by the launch-token user, with sealed logins ("guest-secret"). */
  seed(
    id: string,
    ports?: { readonly http?: number; readonly amqp?: number },
  ): Promise<void>;
}

/** Composes a local-mode engine. `ports` default to fakes over `broker`. */
export async function boot(ports?: BrokerPortsFactory): Promise<Booted> {
  const temp = await tempDir('engine-services-');
  made.push(temp);
  const kekFile = join(temp.dir, 'kek.hex');
  await writeFile(kekFile, randomBytes(32).toString('hex'));
  const mode = await createLocalMode({
    args: { mode: 'local', dataDir: temp.dir, port: 0, kekFile },
    ctl: undefined,
    bundleDir: temp.dir,
    logger: log,
  });
  const broker = scriptedBroker();
  let repos: Repositories | undefined;
  let input: Parameters<BrokerPortsFactory>[0] | undefined;
  const fakes: BrokerPortsFactory = () => ({
    mgmt: broker.read,
    wire: createFakeWire(),
    prober: createFakeProber(),
    close: () => undefined,
  });
  const engine = await composeEngine({
    profile: mode.profile,
    modules: coreModules,
    engineVersion: '0.0.0',
    logger: log,
    logs: createLogTail(),
    trust: { includeSystem: false },
    decorateRepositories: (base) => (repos = base),
    brokerPorts: (given) => {
      input = given;
      return (ports ?? fakes)(given);
    },
  });
  engines.push(engine);
  const token =
    /#t=(.+)$/.exec(
      mode.launchUrl?.({
        host: '127.0.0.1',
        port: engine.address?.port ?? 0,
      }) ?? '',
    )?.[1] ?? '';
  const need = <T>(value: T | undefined): T => {
    if (value === undefined) throw new Error('the engine is not composed');
    return value;
  };
  return {
    engine,
    token,
    broker,
    repos: () => need(repos),
    input: () => need(input),
    call: async (method, path, payload) => {
      const answer = await engine.app.inject({
        method,
        url: `/api/v1${path}`,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload === undefined
            ? {}
            : { 'content-type': 'application/json' }),
          ...(method === 'GET'
            ? {}
            : { 'idempotency-key': randomBytes(12).toString('hex') }),
        },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      });
      return {
        status: answer.statusCode,
        body: answer.json<Record<string, unknown>>(),
      };
    },
    seed: async (id, at = {}) => {
      const sealer = need(input).sealer;
      const seal = (protocol: 'http' | 'amqp') =>
        sealer.seal(
          'credentials',
          'ciphertext',
          `${id}:${protocol}`,
          Buffer.from('guest-secret'),
        );
      await need(repos).connections.save(
        {
          id,
          name: `Lab ${id}`,
          envClass: 'dev',
          color: null,
          config: storedConfig(at.http ?? 15672, at.amqp),
          ownerId: OWNER,
          visibility: 'private',
        },
        { put: { http: await seal('http'), amqp: await seal('amqp') } },
      );
    },
  };
}
