// Integration test of svc-connections against lab brokers (M0-44). Run with
// `pnpm nx run svc-connections:it --versions=4.3.6`; it needs a Docker daemon.
//
// Everything below the service is real: SQLite with the engine's migrations (profiles and the
// `credentials` table), the data-key vault with a KEK file, the management HTTP adapter and the
// AMQP adapter, both dialling through the Dialer. The broker is the lab's TLS variant, so one
// broker answers plain and TLS on every protocol. A user with a canary password is created on it,
// so a login that works proves the secret went through the vault and the store and came back intact.
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bundlesExport,
  connectionsCreate,
  connectionsDelete,
  connectionsTestAmqp,
  connectionsTestHttp,
  type ActionDef,
  type InputOf,
  type OutputOf,
} from '@app/contracts';
import {
  createCanaryScanner,
  createIdGenerator,
  createTestContext,
  createTestPrincipal,
  createWiredExecutor,
} from '@app/kernel';
import {
  createMigrationRunner,
  createRepositories,
  openSqlite,
  type PersistenceHandle,
} from '@app/persistence';
import type { ConnectionProber } from '@app/ports';
import { createDataKeyVault, createFileKekWrap } from '@app/secrets';
import { createConnectionsModule } from '@app/svc-connections';

import { startBroker } from '../broker-lab.ts';
import type { BrokerHandle } from '../lab/types.ts';
import { createRealProber } from './connection-prober.ts';

const versions = (process.env.IT_BROKER_VERSIONS ?? '4.3.6')
  .split(',')
  .filter((version) => version !== '');

/** Passwords that no real text contains: they are the canaries of every scan below. */
const CANARY_PASSWORD = 'CANARY-lab-login-Rq7Wn4Zc2v';
const CANARY_NOTAG = 'CANARY-lab-notag-Hd9Tb5Ms3k';

const portOf = (address: string | undefined): number => {
  if (address === undefined) throw new Error('the broker lacks that listener');
  return Number(new URL(address).port);
};

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
  if (address === null || typeof address === 'string') {
    throw new Error('no port');
  }
  return address.port;
}

async function management(
  broker: BrokerHandle,
  method: 'PUT' | 'DELETE',
  path: string,
  body: unknown,
): Promise<void> {
  const auth = Buffer.from(
    `${broker.credentials.username}:${broker.credentials.password}`,
  ).toString('base64');
  const response = await fetch(`${broker.http}/api${path}`, {
    method,
    headers: {
      authorization: `Basic ${auth}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} answered ${String(response.status)}`);
  }
}

describe.each(versions)('svc-connections against RabbitMQ %s', (version) => {
  let broker: BrokerHandle;
  let handle: PersistenceHandle;
  let directory: string;
  let call: <A extends ActionDef>(
    def: A,
    input: InputOf<A>,
  ) => Promise<OutputOf<A>>;
  let calls = 0;
  /** The prober the service uses; a test swaps it to change what is trusted. */
  const prober: { current: ConnectionProber } = {
    current: createRealProber(),
  };

  beforeAll(async () => {
    broker = await startBroker({ version, variant: 'tls' });
    if (broker.tls === undefined) throw new Error('the lab returned no CA');
    prober.current = createRealProber({
      ca: [broker.tls.ca],
      servername: 'localhost',
    });

    // A login with a canary password, and one that has a login but no management tag.
    await management(broker, 'PUT', '/users/canary-user', {
      password: CANARY_PASSWORD,
      tags: 'monitoring',
    });
    await management(broker, 'PUT', '/permissions/%2F/canary-user', {
      configure: '.*',
      write: '.*',
      read: '.*',
    });
    await management(broker, 'PUT', '/users/notag-user', {
      password: CANARY_NOTAG,
      tags: '',
    });
    await management(broker, 'PUT', '/permissions/%2F/notag-user', {
      configure: '.*',
      write: '.*',
      read: '.*',
    });

    handle = await openSqlite({ path: ':memory:' });
    await createMigrationRunner({ handle }).migrate();
    const repos = createRepositories(handle);
    directory = await mkdtemp(join(tmpdir(), 'svc-connections-it-'));
    const kek = join(directory, 'kek');
    await writeFile(kek, randomBytes(32));
    const vault = createDataKeyVault({
      repository: repos.dataKeys,
      wraps: [createFileKekWrap({ path: kek })],
    });
    await vault.open();

    const ids = createIdGenerator();
    const deps = {
      store: repos.connections,
      sealer: vault.fields,
      prober: {
        http: (...args: Parameters<ConnectionProber['http']>) =>
          prober.current.http(...args),
        amqp: (...args: Parameters<ConnectionProber['amqp']>) =>
          prober.current.amqp(...args),
      },
      newId: () => ids.ulid(),
    };
    const engine = createWiredExecutor();
    for (const action of createConnectionsModule(deps).actions) {
      engine.executor.register(action as never);
    }
    call = async (def, input) => {
      calls += 1;
      const outcome = await engine.executor.run(
        def,
        input,
        createTestContext({
          principal: createTestPrincipal(),
          idempotencyKey: `svc-connections-it-${String(calls)}`,
        }),
      );
      if (outcome.kind !== 'output') {
        throw new Error(`expected an output, got ${outcome.kind}`);
      }
      return outcome.output;
    };
  });

  afterAll(async () => {
    await handle.close();
    await rm(directory, { recursive: true, force: true });
    await broker.stop();
  });

  const lab = () => ({
    host: '127.0.0.1',
    amqpPort: portOf(broker.amqp),
    httpPort: portOf(broker.http),
  });
  const login = (password = CANARY_PASSWORD, username = 'canary-user') => ({
    http: { auth: { kind: 'basic' as const, username, password } },
    amqp: { auth: { kind: 'plain' as const, username, password } },
  });

  it('AC-1 a pasted amqp URI is saved, its secret is sealed in the database, and the stored login works on the real broker over HTTP and over AMQP', async () => {
    const { host, amqpPort, httpPort } = lab();

    const { profile } = await call(connectionsCreate, {
      name: 'Lab',
      envClass: 'dev',
      uri: `amqp://canary-user:${CANARY_PASSWORD}@${host}:${String(amqpPort)}/%2F`,
      // The lab maps the management API to a random port: the one thing the URI cannot derive.
      http: { port: httpPort },
    });
    expect(profile).toMatchObject({
      amqp: { host, port: amqpPort, tls: false, vhost: '/' },
      http: {
        port: httpPort,
        tls: false,
        url: `http://${host}:${String(httpPort)}`,
      },
    });

    // The saved login is opened from the vault and used, once per protocol, by separate tests.
    const http = await call(connectionsTestHttp, { cid: profile.id });
    const amqp = await call(connectionsTestAmqp, { cid: profile.id });
    expect(http).toMatchObject({
      ok: true,
      broker: { product: 'RabbitMQ', version, user: 'canary-user' },
    });
    // The broker lists its AMQP listeners inside the container: 5672 and, on this variant, 5671.
    expect(http.amqpPorts).toEqual({ plain: 5672, tls: 5671 });
    expect(amqp.ok).toBe(true);
    expect(Object.values(amqp.gates).every((gate) => gate.enabled)).toBe(true);

    // The secret is in the database only as ciphertext (I-10): scan every stored byte and column.
    const scanner = createCanaryScanner([CANARY_PASSWORD, CANARY_NOTAG]);
    const rows = [
      ...(await handle.db.selectFrom('credentials').selectAll().execute()),
      ...(await handle.db
        .selectFrom('connection_profiles')
        .selectAll()
        .execute()),
    ];
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(scanner.scan(JSON.stringify(row))).toEqual([]);
      for (const value of Object.values(row)) {
        if (value instanceof Uint8Array) {
          expect(scanner.scan(value)).toEqual([]);
        }
      }
    }
  });

  it('AC-2 with HTTP ok and the AMQP port blocked, test-amqp answers "AMQP port blocked" and the AMQP gates are closed with that reason', async () => {
    const { host, httpPort } = lab();
    const blocked = await closedPort();
    const { profile } = await call(connectionsCreate, {
      name: 'Blocked',
      envClass: 'dev',
      ...login(),
      amqp: { host, port: blocked, auth: login().amqp.auth },
      http: { host, port: httpPort, auth: login().http.auth },
    });

    const http = await call(connectionsTestHttp, { cid: profile.id });
    const amqp = await call(connectionsTestAmqp, { cid: profile.id });

    expect(http.ok).toBe(true);
    expect(amqp.ok).toBe(false);
    expect(amqp.failure?.code).toBe('AMQP_PORT_BLOCKED');
    expect(amqp.failure?.message).toMatch(/^AMQP port blocked/);
    for (const gate of Object.values(amqp.gates)) {
      expect(gate).toMatchObject({
        enabled: false,
        reason: amqp.failure?.message,
      });
    }
  });

  it('a wrong password, a user without a management tag, a vhost the user cannot use and a port that is not the management API each fail with their own specific error', async () => {
    const { host, amqpPort, httpPort } = lab();
    const endpoints = { host, port: httpPort };
    const draftHttp = (username: string, password: string, port = httpPort) =>
      call(connectionsTestHttp, {
        draft: {
          http: {
            ...endpoints,
            port,
            auth: { kind: 'basic', username, password },
          },
        },
      });
    const draftAmqp = (
      password: string,
      vhost = '/',
      username = 'canary-user',
    ) =>
      call(connectionsTestAmqp, {
        draft: {
          amqp: {
            host,
            port: amqpPort,
            vhost,
            auth: { kind: 'plain', username, password },
          },
        },
      });

    expect(
      (await draftHttp('canary-user', 'not-the-password')).failure?.code,
    ).toBe('HTTP_AUTH_REFUSED');
    expect((await draftHttp('notag-user', CANARY_NOTAG)).failure?.code).toBe(
      'HTTP_MISSING_TAG',
    );
    // The AMQP port answers HTTP with its own protocol header, which is no management API.
    expect(
      (await draftHttp('canary-user', CANARY_PASSWORD, amqpPort)).failure?.code,
    ).toBe('HTTP_NOT_MANAGEMENT');

    expect((await draftAmqp('not-the-password')).failure?.code).toBe(
      'AMQP_AUTH_REFUSED',
    );
    expect(
      (await draftAmqp(CANARY_PASSWORD, '/no-such-vhost')).failure?.code,
    ).toBe('AMQP_VHOST_REFUSED');
    // The same logins that work above work here: only the one thing that was wrong is reported.
    expect((await draftAmqp(CANARY_PASSWORD)).ok).toBe(true);
    expect((await draftHttp('canary-user', CANARY_PASSWORD)).ok).toBe(true);
  });

  it('TLS: amqps and https on the lab broker verify against its CA by IP with a server name, and an untrusted certificate is its own error', async () => {
    const { host } = lab();
    const draft = {
      http: {
        host,
        port: portOf(broker.https),
        tls: true,
        auth: login().http.auth,
      },
      amqp: {
        host,
        port: portOf(broker.amqps),
        tls: true,
        auth: login().amqp.auth,
      },
    };

    const http = await call(connectionsTestHttp, { draft });
    const amqp = await call(connectionsTestAmqp, { draft });
    expect(http).toMatchObject({
      ok: true,
      target: { url: `https://${host}:${String(portOf(broker.https))}` },
    });
    expect(amqp.ok).toBe(true);

    // Without the lab CA the same endpoints are untrusted, over both protocols.
    const trusted = prober.current;
    prober.current = createRealProber({ servername: 'localhost' });
    try {
      expect((await call(connectionsTestHttp, { draft })).failure?.code).toBe(
        'HTTP_TLS_UNTRUSTED',
      );
      expect((await call(connectionsTestAmqp, { draft })).failure?.code).toBe(
        'AMQP_TLS_UNTRUSTED',
      );
    } finally {
      prober.current = trusted;
    }
  });

  it('AC-2 a bundle exported from the real store holds no secret, and deleting a profile removes its stored credentials', async () => {
    const { host, amqpPort, httpPort } = lab();
    const { profile } = await call(connectionsCreate, {
      name: 'To export',
      envClass: 'staging',
      uri: `amqp://canary-user:${CANARY_PASSWORD}@${host}:${String(amqpPort)}/`,
      http: { port: httpPort },
    });

    const { bundle } = await call(bundlesExport, {});

    expect(bundle.profiles.map((entry) => entry.name)).toContain('To export');
    const scanner = createCanaryScanner([CANARY_PASSWORD, CANARY_NOTAG]);
    expect(scanner.scan(JSON.stringify(bundle))).toEqual([]);

    const before = await handle.db
      .selectFrom('credentials')
      .select('protocol')
      .where('connection_id', '=', profile.id)
      .execute();
    expect(before.map((row) => row.protocol).sort()).toEqual(['amqp', 'http']);
    await call(connectionsDelete, { cid: profile.id });
    expect(
      await handle.db
        .selectFrom('credentials')
        .select('protocol')
        .where('connection_id', '=', profile.id)
        .execute(),
    ).toEqual([]);
  });
});
