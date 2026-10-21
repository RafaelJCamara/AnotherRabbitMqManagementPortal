// Integration test of the composed engine against a lab broker (M0-wiring, issue #278). Run with
// `pnpm nx run engine:it` (`--versions=4.3.6`); it needs a Docker daemon (Linux in CI) and the built
// bundle (`engine:it` builds it).
//
// Everything is real: the engine bundle as a process in local mode (the way `engine:serve` starts it),
// its SQLite file, key wrap and vault, the router, the executor, the BrokerScheduler, the management
// adapter over the Dialer, the wire probe over the AMQP adapter, the explorer's sweeper and the live
// hub, and a RabbitMQ from the broker lab with seeded queues.
//
// A connection cannot be created through the engine yet: `connections.create` names no connection, so
// the prod lock refuses it (OQ-380, OQ-770). The test therefore writes the profile into the database
// before the engine starts, with the stores and the vault it uses (a test, not a feature), and asserts
// the refusal so the day it is ruled on this test says so.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createMigrationRunner,
  createRepositories,
  openSqlite,
} from '@app/persistence';
import { createDataKeyVault, createFileKekWrap } from '@app/secrets';

import { startBroker } from '../broker-lab.ts';
import type { BrokerHandle } from '../lab/types.ts';
import { seedQueues, waitForQueueTotal } from './seed-queues.ts';

const version = (process.env.IT_BROKER_VERSIONS ?? '4.3.6')
  .split(',')
  .find((entry) => entry !== '');
const QUEUES = 30;
const VHOSTS = 2;
const CID = 'lab';
const bundle = fileURLToPath(
  new URL('../../../../dist/apps/engine/main.mjs', import.meta.url),
);

const portOf = (address: string): number => Number(new URL(address).port);

describe(`the composed engine against RabbitMQ ${String(version)}`, () => {
  let broker: BrokerHandle;
  let dir: string;
  let child: ChildProcess;
  let base = '';
  let token = '';

  const call = async (
    method: 'GET' | 'POST',
    path: string,
    payload?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const answer = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload === undefined
          ? {}
          : { 'content-type': 'application/json' }),
        ...(method === 'GET'
          ? {}
          : { 'idempotency-key': randomBytes(12).toString('hex') }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    return {
      status: answer.status,
      body: (await answer.json()) as Record<string, unknown>,
    };
  };

  beforeAll(async () => {
    broker = await startBroker({ version: version ?? '4.3.6' });
    await seedQueues({
      origin: broker.http,
      login: broker.credentials,
      count: QUEUES,
      vhosts: VHOSTS,
    });
    await waitForQueueTotal({
      origin: broker.http,
      login: broker.credentials,
      expected: QUEUES,
    });

    // The profile, written the way the engine would have (OQ-770), before the engine owns the file.
    dir = await mkdtemp(join(tmpdir(), 'engine-it-'));
    const kekFile = join(dir, 'kek.hex');
    await writeFile(kekFile, randomBytes(32).toString('hex'));
    const handle = await openSqlite({ path: join(dir, 'engine.db') });
    try {
      await createMigrationRunner({ handle }).migrate();
      const repos = createRepositories(handle);
      const vault = createDataKeyVault({
        repository: repos.dataKeys,
        wraps: [createFileKekWrap({ path: kekFile })],
      });
      await vault.open();
      const seal = (protocol: 'http' | 'amqp') =>
        vault.fields.seal(
          'credentials',
          'ciphertext',
          `${CID}:${protocol}`,
          Buffer.from(broker.credentials.password),
        );
      const login = (kind: 'basic' | 'plain') => ({
        kind,
        username: broker.credentials.username,
      });
      await repos.connections.save(
        {
          id: CID,
          name: 'Lab broker',
          envClass: 'dev',
          color: null,
          config: {
            v: 1,
            http: {
              host: '127.0.0.1',
              port: portOf(broker.http),
              tls: false,
              pathPrefix: null,
              auth: login('basic'),
            },
            amqp: {
              host: '127.0.0.1',
              port: portOf(broker.amqp),
              tls: false,
              vhost: '/',
              auth: login('plain'),
            },
          },
          ownerId: 'local-token',
          visibility: 'private',
        },
        { put: { http: await seal('http'), amqp: await seal('amqp') } },
      );
    } finally {
      await handle.close();
    }

    child = spawn(
      process.execPath,
      [
        bundle,
        '--mode=local',
        '--port=0',
        `--data-dir=${dir}`,
        `--kek-file=${kekFile}`,
        '--log-level=warn',
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const url = await new Promise<string>((resolve, reject) => {
      let seen = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        seen += chunk.toString('utf8');
        const match = /(http:\/\/127\.0\.0\.1:\d+)\/#t=([A-Za-z0-9_-]+)/.exec(
          seen,
        );
        if (match?.[1] !== undefined && match[2] !== undefined) {
          token = match[2];
          resolve(match[1]);
        }
      });
      child.on('exit', (code) => {
        reject(new Error(`the engine exited with ${String(code)}`));
      });
    });
    base = url;
  }, 600_000);

  afterAll(async () => {
    // Any of these may be unset when `beforeAll` failed part of the way.
    (child as ChildProcess | undefined)?.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const made = dir as string | undefined;
    if (made !== undefined) {
      await rm(made, { recursive: true, force: true, maxRetries: 5 });
    }
    await (broker as BrokerHandle | undefined)?.stop();
  });

  it('probe.run reads the broker through the real adapters and caches the profile; profile.get returns it', async () => {
    const probe = await call('POST', `/connections/${CID}/probe`, {});

    expect(probe.status).toBe(200);
    expect(probe.body).toMatchObject({
      changed: true,
      profile: { product: 'rabbitmq', versions: { min: { raw: version } } },
    });
    const steps = probe.body.steps as { id: string; status: string }[];
    expect(steps.find((step) => step.id === 'amqp-handshake')?.status).toBe(
      'ok',
    );
    const profile = await call('GET', `/connections/${CID}/profile`);
    expect(profile.status).toBe(200);
    expect(profile.body).toMatchObject({
      profile: {
        fingerprint: (probe.body.profile as { fingerprint: string })
          .fingerprint,
      },
    });
  });

  it('inventory.query and overview.get answer from the sweep of the broker', async () => {
    const queues = () =>
      call('POST', `/connections/${CID}/inventory/queries`, {
        kind: 'queues',
        window: { offset: 0, limit: 100 },
      });
    const deadline = Date.now() + 60_000;
    let rows = 0;
    while (rows < QUEUES && Date.now() < deadline) {
      rows = ((await queues()).body.rows as unknown[]).length;
      if (rows < QUEUES)
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const overview = await call('GET', `/connections/${CID}/overview`);

    expect(rows).toBe(QUEUES);
    expect(overview.status).toBe(200);
    expect(overview.body).toMatchObject({
      product: 'RabbitMQ',
      totals: { queues: QUEUES },
    });
  });

  it('connections.test-http and connections.test-amqp of the saved profile succeed against the broker', async () => {
    const http = await call('POST', '/connections/test-http', { cid: CID });
    const amqp = await call('POST', '/connections/test-amqp', { cid: CID });

    expect(http.body).toMatchObject({
      ok: true,
      broker: { product: 'RabbitMQ', version },
    });
    expect(amqp.body).toMatchObject({ ok: true });
  });

  it('a broker that refuses the login is a failed test with its cause, and the login is not echoed', async () => {
    const refused = await call('POST', '/connections/test-http', {
      draft: {
        http: {
          host: '127.0.0.1',
          port: portOf(broker.http),
          auth: { kind: 'basic', username: 'nobody', password: 'wrong-pass' },
        },
      },
    });

    expect(refused.body).toMatchObject({
      ok: false,
      failure: { code: 'HTTP_AUTH_REFUSED' },
    });
    expect(JSON.stringify(refused.body)).not.toContain('wrong-pass');
  });

  it('connections.create is refused by the prod lock on a running engine (OQ-380, OQ-770: the known limitation)', async () => {
    const created = await call('POST', '/connections', {
      name: 'Another',
      envClass: 'dev',
      http: { host: '127.0.0.1', port: portOf(broker.http) },
    });

    expect(created.status).toBe(422);
    expect(created.body).toMatchObject({ code: 'GATE_BLOCKED' });
  });
});
