// The composition root over a real SQLite file, a real socket and the real executor, audit chain,
// job runner, live hub and router. Test names quote the acceptance criterion they prove.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';

import { AppError, createLogger } from '@app/kernel';
import {
  createRepositories,
  executeRawStatement,
  openSqlite,
  SchemaTooNewError,
} from '@app/persistence';
import { SecretsError } from '@app/secrets';
import { afterEach, describe, expect, it } from 'vitest';

import { composeEngine, type ModeProfile } from './compose-core.ts';
import { DataDirLockedError, LOCK_FILE } from './data-dir-lock.ts';
import { createLocalMode } from './modes/local.ts';
import { coreModules } from './modules/index.ts';
import {
  localArgs,
  startForTest,
  tempDir,
  type RunningEngine,
  type TempDir,
} from './testing/harness.ts';

const open: RunningEngine[] = [];
const dirs: TempDir[] = [];

async function newDir(): Promise<string> {
  const made = await tempDir();
  dirs.push(made);
  return made.dir;
}

async function start(
  dir: string,
  extra: readonly string[] = [],
): Promise<RunningEngine> {
  const running = await startForTest(localArgs(dir, extra));
  open.push(running);
  return running;
}

afterEach(async () => {
  for (const running of open.splice(0)) await running.engine.close();
  for (const made of dirs.splice(0)) await made.cleanup();
});

const get = (
  base: string | undefined,
  path: string,
  headers: Record<string, string> = {},
) => fetch(`${base ?? ''}${path}`, { headers });

/** Node's `fetch` will not send a Host of our choosing; this does, as a rebinding page would. */
function statusWithHost(
  base: string | undefined,
  path: string,
  host: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = new URL(path, base);
    const request = httpRequest(
      { host: target.hostname, port: target.port, path, headers: { host } },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on('error', reject);
    request.end();
  });
}

/** `ops.arm` over HTTP with the launch token: the cheapest audited command the engine has. */
const arm = (engine: RunningEngine, key: string) =>
  fetch(`${engine.base ?? ''}/api/v1/connections/c1/arm`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${engine.token ?? ''}`,
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    body: '{}',
  });

describe('local mode boot', () => {
  it('AC-1 --mode=local --port=0 answers /healthz green on a socket it chose', async () => {
    const engine = await start(await newDir());

    const health = await get(engine.base, '/healthz');

    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });
    expect(engine.engine.address?.host).toBe('127.0.0.1');
    expect(engine.engine.address?.port).toBeGreaterThan(0);
    expect((await get(engine.base, '/readyz')).status).toBe(200);
  });

  it('AC-1 a second engine on the same data directory refuses with a lock error, and the first keeps serving', async () => {
    const dir = await newDir();
    const first = await start(dir);

    await expect(startForTest(localArgs(dir))).rejects.toBeInstanceOf(
      DataDirLockedError,
    );

    expect((await get(first.base, '/healthz')).status).toBe(200);
    expect(existsSync(join(dir, LOCK_FILE))).toBe(true);
    await first.engine.close();
    // The lock is released on a clean stop, so the directory can be used again.
    const third = await start(dir);
    expect((await get(third.base, '/healthz')).status).toBe(200);
  });

  it('AC-1 the engine starts in the order lock, migrate, vault, trust store, reconcile, listen, ready', async () => {
    const engine = await start(await newDir());

    expect(engine.engine.steps).toEqual([
      'lock',
      'migrate',
      'vault',
      'trust-store',
      'reconcile',
      'listen',
      'ready',
    ]);
  });

  it('the ready line carries the contract and the schema hash, and names what was not reconciled', async () => {
    const engine = await start(await newDir());

    const ready = engine.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.event === 'engine.ready');

    expect(ready).toMatchObject({
      contract: engine.engine.ready.contract,
      schemaHash: engine.engine.ready.schemaHash,
      reconciliationPending: [
        'plans-executing',
        'audit-attempts',
        'hold-journal',
        'replay-journal',
        'firehose-leases',
        'tap-sweep',
      ],
    });
    expect(engine.engine.ready.contract).toMatch(/^[0-9a-f]{64}$/);
    expect(engine.engine.ready.schemaHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('serves meta.get through the router only to the launch token', async () => {
    const engine = await start(await newDir());

    const anonymous = await get(engine.base, '/api/v1/meta');
    const wrong = await get(engine.base, '/api/v1/meta', {
      authorization: `Bearer ${randomBytes(32).toString('base64url')}`,
    });
    const allowed = await get(engine.base, '/api/v1/meta', {
      authorization: `Bearer ${engine.token ?? ''}`,
    });

    expect(anonymous.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({
      engineVersion: expect.any(String) as string,
      apiVersion: 'v1',
      mode: 'local',
    });
  });

  it('refuses a request whose Host is not loopback, health check included (DNS rebinding)', async () => {
    const engine = await start(await newDir());

    const rebound = await statusWithHost(
      engine.base,
      '/healthz',
      'evil.example',
    );
    const same = await statusWithHost(
      engine.base,
      '/healthz',
      new URL(engine.base ?? '').host,
    );

    expect(rebound).toBe(403);
    expect(same).toBe(200);
  });

  it('wires the live hub: a launch-token holder gets a ticket, an anonymous caller does not', async () => {
    const engine = await start(await newDir());
    const post = (headers: Record<string, string>) =>
      fetch(`${engine.base ?? ''}/api/v1/live/tickets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: '{}',
      });

    const anonymous = await post({});
    const allowed = await post({
      authorization: `Bearer ${engine.token ?? ''}`,
    });

    expect(anonymous.status).toBe(401);
    expect(allowed.status).toBe(200);
    expect(((await allowed.json()) as { ticket: string }).ticket).toMatch(
      /\S{20,}/,
    );
  });

  it('puts the launch token on the console once and in no log line (I-10)', async () => {
    const engine = await start(await newDir());
    await get(engine.base, '/api/v1/meta', {
      authorization: `Bearer ${engine.token ?? ''}`,
    });

    expect(engine.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(engine.consoleText.join('')).toContain(`#t=${engine.token ?? ''}`);
    expect(
      engine.lines.some((line) => line.includes(engine.token ?? '?')),
    ).toBe(false);
  });

  it('writes the arm audit attempt and outcome of an executor call to the SQLite file', async () => {
    const dir = await newDir();
    const engine = await start(dir);
    const armed = await arm(engine, 'spec-key-audit-1');
    expect(armed.status).toBe(200);

    const reader = await openSqlite({ path: join(dir, 'engine.db') });
    try {
      const rows = await createRepositories(reader).audit.window(0, 10);
      expect(rows.map((row) => row.actionId)).toEqual(['ops.arm', 'ops.arm']);
      expect(rows.map((row) => row.phase)).toEqual(['attempt', 'outcome']);
      expect(rows.map((row) => row.actorId)).toEqual([
        'local-token',
        'local-token',
      ]);
      expect(rows[1]?.result).toBe('ok');
    } finally {
      await reader.close();
    }
  });

  it('serves the web build from --ui-dir with a nonce, next to the health check', async () => {
    const dir = await newDir();
    const ui = join(dir, 'ui');
    await mkdir(ui);
    await writeFile(
      join(ui, 'index.html'),
      '<!doctype html><script nonce="__CSP_NONCE__">1</script>',
    );
    const engine = await start(dir, [`--ui-dir=${ui}`]);

    const page = await get(engine.base, '/', { accept: 'text/html' });

    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("'nonce-");
    expect(await page.text()).not.toContain('__CSP_NONCE__');
    expect((await get(engine.base, '/healthz')).status).toBe(200);
  });
});

describe('shutdown', () => {
  it('a drain turns /readyz to 503, refuses new mutations, closes the database and close() frees the lock and the socket', async () => {
    const dir = await newDir();
    const engine = await start(dir);

    const results = await engine.engine.drain('sigterm', 2000);
    const ready = await get(engine.base, '/readyz');
    const armed = await arm(engine, 'spec-key-drain-1');

    expect(results.map((result) => [result.phase, result.ok])).toEqual([
      ['gate', true],
      ['peeks', true],
      ['sources-jobs', true],
      ['taps-firehose', true],
      ['flush', true],
    ]);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: 'draining' });
    expect(armed.status).toBe(503);
    expect(((await armed.json()) as { code: string }).code).toBe(
      'ENGINE_SHUTTING_DOWN',
    );

    await engine.engine.close();
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
    await expect(get(engine.base, '/healthz')).rejects.toThrow();
    expect(await readdir(dir)).not.toContain(`${LOCK_FILE}.stale`);
  });
});

describe('start failures leave nothing behind', () => {
  const log = createLogger({ level: 'silent' });
  const profileOf = async (dir: string): Promise<ModeProfile> =>
    (
      await createLocalMode({
        args: { mode: 'local', dataDir: dir, port: 0 },
        ctl: undefined,
        bundleDir: dir,
        logger: log,
      })
    ).profile;
  const compose = (profile: ModeProfile) =>
    composeEngine({
      profile,
      modules: coreModules,
      engineVersion: '0.0.0',
      logger: log,
      trust: { includeSystem: false },
    });

  it('refuses a listener outside loopback before it takes the lock or opens a file', async () => {
    const dir = await newDir();
    const profile = await profileOf(dir);

    const failure = await compose({
      ...profile,
      listener: { host: '0.0.0.0', port: 0 },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe('GATE_BLOCKED');
    expect(await readdir(dir)).toEqual([]);
  });

  it('refuses a database from a newer engine, changes nothing, and releases the lock', async () => {
    const dir = await newDir();
    const path = join(dir, 'engine.db');
    const seed = await openSqlite({ path });
    await executeRawStatement(
      seed,
      'CREATE TABLE schema_migrations (id TEXT NOT NULL PRIMARY KEY, applied_at BIGINT NOT NULL)',
    );
    await executeRawStatement(
      seed,
      "INSERT INTO schema_migrations (id, applied_at) VALUES ('0099_from_the_future', 1)",
    );
    await seed.close();
    const before = await readFile(path);

    const failure = await compose(await profileOf(dir)).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(SchemaTooNewError);
    expect(Buffer.from(await readFile(path)).equals(before)).toBe(true);
    expect(await readdir(dir)).toEqual(['engine.db']);
  });

  it('closes the database and releases the lock when a later step fails', async () => {
    const dir = await newDir();
    const profile = await profileOf(dir);

    const failure = await compose({
      ...profile,
      // Port 1 on loopback needs privileges the test does not have; a taken port is the portable way.
      listener: { host: '127.0.0.1', port: await takenPort() },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
    // The database file can be opened and written by the next engine at once.
    const next = await compose(profile);
    await next.close();
  });
});

const taken: Server[] = [];
afterEach(() => {
  for (const server of taken.splice(0)) server.close();
});

/** A loopback port something else is listening on, so that binding it fails. */
async function takenPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  taken.push(server);
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
}

describe('the data-key vault', () => {
  it('stays locked without a key source, and unlocks from --kek-file and again after a restart', async () => {
    const dir = await newDir();
    const kek = join(dir, 'kek.key');
    await writeFile(kek, randomBytes(32));

    const locked = await start(await newDir());
    const first = await start(dir, [`--kek-file=${kek}`]);
    const firstState = first.engine.vault().state;
    await first.engine.close();
    const second = await start(dir, [`--kek-file=${kek}`]);

    expect(locked.engine.vault().state).toBe('locked');
    expect(firstState).toBe('unlocked');
    expect(second.engine.vault().state).toBe('unlocked');
  });

  it('does not start with a different KEK over an existing key, and leaves the database and the lock alone', async () => {
    const dir = await newDir();
    const kek = join(dir, 'kek.key');
    await writeFile(kek, randomBytes(32));
    const first = await start(dir, [`--kek-file=${kek}`]);
    await first.engine.close();
    const wrong = join(dir, 'other.key');
    await writeFile(wrong, randomBytes(32));

    const failure = await startForTest(
      localArgs(dir, [`--kek-file=${wrong}`]),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SecretsError);
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
    // Nothing was replaced: the right KEK still opens the stored key.
    const again = await start(dir, [`--kek-file=${kek}`]);
    expect(again.engine.vault().state).toBe('unlocked');
  });
});

describe('reconciliation at start', () => {
  it('a job a crash left running is paused-interrupted before the engine is ready', async () => {
    const dir = await newDir();
    const first = await start(dir);
    await first.engine.close();
    // Simulate the crash: a job claimed by an engine that never finished it.
    const seed = await openSqlite({ path: join(dir, 'engine.db') });
    const repos = createRepositories(seed);
    const { job } = await repos.jobs.create(
      {
        id: 'job-crashed' as never,
        type: 'queues.purge',
        version: 1,
        principalId: 'local-token',
        onBehalfOfId: null,
        planHash: null,
        idempotencyKey: 'k1',
        concurrencyKey: null,
        resumable: false,
        input: new Uint8Array([1, 2, 3]),
      },
      Date.now(),
    );
    await repos.jobs.claim('dead-engine', 30_000, ['queues.purge'], Date.now());
    await seed.close();

    const second = await start(dir);

    const jobs = second.engine.reconciliation.find(
      (report) => report.name === 'jobs',
    );
    expect(jobs?.outcome).toMatchObject({
      status: 'done',
      detail: { interrupted: 1, resumed: 0 },
    });
    const check = await openSqlite({ path: join(dir, 'engine.db') });
    try {
      expect((await createRepositories(check).jobs.get(job.id))?.state).toBe(
        'paused-interrupted',
      );
    } finally {
      await check.close();
    }
  });
});
