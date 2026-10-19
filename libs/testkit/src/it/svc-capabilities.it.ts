// Integration test of svc-capabilities against lab brokers (M0-45). Run with
// `pnpm nx run svc-capabilities:it --versions=3.13.7,4.0.9,4.1.8,4.2.9,4.3.6`; it needs a Docker daemon.
//
// Everything below the service is real: the management HTTP adapter behind the BrokerScheduler's
// read wrapper, the TLS and AMQP handshakes through the Dialer, SQLite with the engine's migrations
// (the `broker_profiles` cache) and the executor. The broker is the lab's TLS variant, so the
// management API is reached over HTTPS with the lab CA, and one probe covers every step.
import { createServer } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMgmtHttpClient, type MgmtTarget } from '@app/adapter-mgmt-http';
import { PROBE_STEP_IDS, probeRun, profileGet } from '@app/contracts';
import {
  BrokerScheduler,
  createTestContext,
  createTestPrincipal,
  createWiredExecutor,
  scheduleMgmtRead,
} from '@app/kernel';
import { createDialer } from '@app/net-dialer';
import type { MgmtReadPort } from '@app/ports';
import { createTrustStore } from '@app/net-truststore';
import {
  createMigrationRunner,
  createRepositories,
  openSqlite,
  type PersistenceHandle,
  type Repositories,
} from '@app/persistence';
import { createCapabilitiesModule } from '@app/svc-capabilities';

import { startBroker } from '../broker-lab.ts';
import type { BrokerHandle } from '../lab/types.ts';
import { createRealWireProbe } from './wire-probe.ts';

const versions = (process.env.IT_BROKER_VERSIONS ?? '4.3.6')
  .split(',')
  .filter((version) => version !== '');

const DIRECT = { kind: 'direct' } as const;
const CID = 'c1';

const portOf = (address: string | undefined): number => {
  if (address === undefined) throw new Error('the broker lacks that listener');
  return Number(new URL(address).port);
};

/** The era the version numbers imply, written out so the test does not use the code it checks. */
const eraOf = (version: string): string =>
  version.startsWith('3.')
    ? '3.13'
    : version.startsWith('4.3')
      ? '4.3'
      : '4.0-4.2';

/** Nothing is known of the broker yet: the adapter's rules read this conservatively. */
const UNPROBED = {
  product: 'unknown',
  stats: { disabled: false, queueTotals: false },
  versions: {
    min: null,
    perNode: {},
    mixed: false,
    build: 'commercial-or-unknown',
  },
} as const;

describe.each(versions)('svc-capabilities against RabbitMQ %s', (version) => {
  let broker: BrokerHandle;
  let handle: PersistenceHandle;
  let repos: Repositories;
  let call: <T>(
    run: (ctx: ReturnType<typeof createTestContext>) => Promise<T>,
  ) => Promise<T>;
  let engine: ReturnType<typeof createWiredExecutor>;
  let calls = 0;
  let closeClient: () => void = () => undefined;
  let reader: MgmtReadPort;

  beforeAll(async () => {
    broker = await startBroker({ version, variant: 'tls' });
    if (broker.tls === undefined || broker.https === undefined) {
      throw new Error('the lab returned no TLS endpoint');
    }
    const trust = createTrustStore().forProfile({
      ca: [broker.tls.ca],
      servername: 'localhost',
    });
    const target: MgmtTarget = {
      host: '127.0.0.1',
      port: portOf(broker.https),
      route: DIRECT,
      tls: trust,
      profile: UNPROBED,
      auth: {
        kind: 'basic',
        username: broker.credentials.username,
        password: broker.credentials.password,
      },
    };
    const client = createMgmtHttpClient({
      dialer: createDialer(),
      targets: { resolve: () => Promise.resolve(target) },
      requestTimeoutMs: 15_000,
    });
    closeClient = () => {
      client.close();
    };
    // The scheduler is what services are really given (I-8): it merges and caches identical reads.
    reader = scheduleMgmtRead(client.read, new BrokerScheduler());

    handle = await openSqlite({ path: ':memory:' });
    await createMigrationRunner({ handle }).migrate();
    repos = createRepositories(handle);
    const principal = createTestPrincipal();
    await repos.connections.save({
      id: CID,
      name: 'Lab',
      envClass: 'dev',
      color: null,
      config: {},
      ownerId: principal.id,
      visibility: 'private',
    });

    engine = createWiredExecutor();
    const module = createCapabilitiesModule({
      mgmt: reader,
      wire: createRealWireProbe({
        host: '127.0.0.1',
        managementTls: { port: portOf(broker.https) },
        amqp: {
          port: portOf(broker.amqps),
          vhost: '/',
          username: broker.credentials.username,
          password: broker.credentials.password,
          tls: true,
        },
        ca: [broker.tls.ca],
        servername: 'localhost',
      }),
      profiles: repos.brokerProfiles,
      connections: repos.connections,
    });
    for (const action of module.actions) {
      engine.executor.register(action as never);
    }
    call = (run) => {
      calls += 1;
      return run(
        createTestContext({
          principal,
          idempotencyKey: `svc-capabilities-it-${String(calls)}`,
        }),
      );
    };
  }, 300_000);

  afterAll(async () => {
    closeClient();
    await handle.close();
    await broker.stop();
  });

  const run = async <T>(
    def: typeof probeRun | typeof profileGet,
    input: { cid: string },
  ): Promise<T> =>
    call(async (ctx) => {
      const outcome = await engine.executor.run(def, input, ctx);
      if (outcome.kind !== 'output') {
        throw new Error(`expected an output, got ${outcome.kind}`);
      }
      return outcome.output as T;
    });

  it('AC-1 the probe reads the broker, builds a BrokerProfile and caches it; a second probe of an unchanged broker has the same fingerprint', async () => {
    const first = await run<{
      profile: Record<string, unknown> & {
        fingerprint: string;
        versions: {
          min: { raw: string } | null;
          perNode: Record<string, unknown>;
        };
        era: { value: string };
        tls: { verified: boolean; notAfter?: number };
        lbFronted: { value: boolean };
        identity: { isAdmin: boolean };
        stats: { disabled: boolean };
        auth: { oauth?: unknown };
        provider: string;
        product: string;
      };
      changed: boolean;
      steps: { id: string; status: string; detail?: string }[];
    }>(probeRun, { cid: CID });

    expect(first.steps.map((step) => step.id)).toEqual([...PROBE_STEP_IDS]);
    // Nothing the probe reads is missing on a lab broker: no step fails, and what the broker has
    // not got (OAuth, the vendor objects of a provider) is "unavailable" or an empty answer.
    expect(first.steps.filter((step) => step.status === 'failed')).toEqual([]);
    expect(first.steps.find((step) => step.id === 'nodes')?.detail).toBe(
      '1 node(s)',
    );
    expect(first.steps.find((step) => step.id === 'tls')?.status).toBe('ok');
    expect(
      first.steps.find((step) => step.id === 'amqp-handshake')?.status,
    ).toBe('ok');

    const { profile } = first;
    expect(profile.product).toBe('rabbitmq');
    expect(profile.provider).toBe('self-hosted');
    expect(profile.versions.min?.raw).toBe(version);
    expect(Object.keys(profile.versions.perNode)).toHaveLength(1);
    expect(profile.era.value).toBe(eraOf(version));
    expect(profile.tls.verified).toBe(true);
    expect(profile.tls.notAfter).toBeGreaterThan(Date.now());
    expect(profile.lbFronted.value).toBe(false);
    expect(profile.identity.isAdmin).toBe(true);
    expect(profile.stats.disabled).toBe(false);
    expect(profile.auth.oauth).toBeUndefined();
    expect(first.changed).toBe(true);

    const cached = await repos.brokerProfiles.get(CID);
    expect(cached?.fingerprint).toBe(profile.fingerprint);

    const second = await run<{
      changed: boolean;
      profile: { fingerprint: string };
    }>(probeRun, { cid: CID });
    expect(second.changed).toBe(false);
    expect(second.profile.fingerprint).toBe(profile.fingerprint);

    const read = await run<{ profile: unknown }>(profileGet, { cid: CID });
    expect(read.profile).toEqual(second.profile);
  });

  it('AC-2 a broker with no AMQP listener still gets a profile: the handshake is "unavailable", never a failure of the probe', async () => {
    const closed = await closedPort();
    const blocked = createCapabilitiesModule({
      mgmt: reader,
      wire: createRealWireProbe({
        host: '127.0.0.1',
        amqp: {
          port: closed,
          vhost: '/',
          username: broker.credentials.username,
          password: broker.credentials.password,
        },
      }),
      profiles: repos.brokerProfiles,
      connections: repos.connections,
    });
    const other = createWiredExecutor();
    for (const action of blocked.actions) {
      other.executor.register(action as never);
    }

    const outcome = await call((ctx) =>
      other.executor.run(probeRun, { cid: CID }, ctx),
    );

    if (outcome.kind !== 'output') throw new Error(outcome.kind);
    expect(
      outcome.output.steps.find((step) => step.id === 'amqp-handshake'),
    ).toMatchObject({ status: 'unavailable', detail: 'unreachable' });
    expect(outcome.output.steps.find((step) => step.id === 'tls')?.status).toBe(
      'skipped',
    );
  });
});

/** A TCP port nothing listens on: bound by a server for a moment, then released. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  if (address === null || typeof address === 'string')
    throw new Error('no port');
  return address.port;
}
