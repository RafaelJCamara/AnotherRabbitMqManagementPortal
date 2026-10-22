// `nx run engine:smoke`: the built `dist/apps/engine/main.mjs`, started as a process, the way a
// supervisor starts it. A forked child has an IPC channel, which is the control channel here, so the
// graceful stop works on Windows too (where a signal would kill the process outright).
import { spawn, type ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { builtinModules } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { randomBytes } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const bundle = join(root, 'dist', 'apps', 'engine', 'main.mjs');
const metafile = join(root, 'dist', 'apps', 'engine', 'meta.json');

interface Started {
  readonly child: ChildProcess;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly messages: Record<string, unknown>[];
  readonly exit: Promise<number | null>;
}

const children: ChildProcess[] = [];
const dirs: string[] = [];

function launch(args: string[], env?: Record<string, string>): Started {
  const child = spawn(process.execPath, [bundle, ...args], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    serialization: 'advanced',
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  });
  children.push(child);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const messages: Record<string, unknown>[] = [];
  let pending = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    stdout.push(...lines);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr.push(chunk.toString('utf8'));
  });
  child.on('message', (message) => {
    messages.push(message as Record<string, unknown>);
  });
  const exit = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => {
      resolve(code);
    });
  });
  return { child, stdout, stderr, messages, exit };
}

async function until<T>(
  what: string,
  probe: () => T | undefined,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const event = (
  started: Started,
  name: string,
): Record<string, unknown> | undefined =>
  started.stdout
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((line) => line.event === name);

async function newDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'engine-smoke-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const dir of dirs.splice(0)) {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

describe('the bundle', () => {
  it('exists: run `pnpm nx build engine` first', () => {
    expect(existsSync(bundle)).toBe(true);
    expect(existsSync(metafile)).toBe(true);
  });

  it('AC-1 --mode=local --port=0 is green on /healthz within 1 s, and a second engine on the same data directory refuses with a lock error', async () => {
    // A bundle that was written a moment ago is read from disk (and scanned) the first time it
    // runs: warm it up with one start that is not timed, as a second start of the product is.
    const warm = launch([
      '--mode=local',
      '--port=0',
      `--data-dir=${await newDir()}`,
    ]);
    await until('the warm-up engine', () => event(warm, 'engine.ready'));
    warm.child.kill('SIGKILL');
    await warm.exit;

    const data = await newDir();
    const first = launch(['--mode=local', '--port=0', `--data-dir=${data}`]);
    const ready = await until('engine.ready', () =>
      event(first, 'engine.ready'),
    );

    const health = await fetch(
      `http://127.0.0.1:${String(ready.port)}/healthz`,
    );

    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });
    // The engine's own clock, from the start of the process to the ready line.
    expect(ready.startupMs).toBeLessThan(1000);
    expect(ready.contract).toMatch(/^[0-9a-f]{64}$/);

    const second = launch(['--mode=local', '--port=0', `--data-dir=${data}`]);
    const code = await second.exit;

    expect(code).toBe(75);
    const failure = JSON.parse(second.stderr.join('').trim()) as Record<
      string,
      unknown
    >;
    expect(failure).toMatchObject({
      event: 'engine.start.failed',
      reason: 'data-dir-locked',
      holderPid: first.child.pid,
    });
    expect(second.stdout.filter((line) => line.startsWith('http'))).toEqual([]);
    expect(
      (await fetch(`http://127.0.0.1:${String(ready.port)}/healthz`)).status,
    ).toBe(200);
  });

  it('stops on ctl:shutdown with exit 0, frees the lock and the socket, and posts ready on the control channel', async () => {
    const data = await newDir();
    const engine = launch(['--mode=local', '--port=0', `--data-dir=${data}`]);
    const ready = await until('engine.ready', () =>
      event(engine, 'engine.ready'),
    );
    const posted = await until('ctl:ready', () =>
      engine.messages.find((message) => message.t === 'ready'),
    );

    engine.child.send({ t: 'shutdown', deadlineMs: 2000 });
    const code = await engine.exit;

    expect(posted).toEqual({
      t: 'ready',
      contract: ready.contract,
      schemaHash: ready.schemaHash,
    });
    expect(code).toBe(0);
    expect(event(engine, 'engine.stopped')).toMatchObject({ reason: 'quit' });
    expect(await readdir(data)).not.toContain('engine.lock');
    await expect(
      fetch(`http://127.0.0.1:${String(ready.port)}/healthz`),
    ).rejects.toThrow();
  });

  it('honours a ctl:shutdown that arrives while the engine is still starting', async () => {
    const data = await newDir();
    const engine = launch(['--mode=local', '--port=0', `--data-dir=${data}`]);
    // Sent at once, long before the engine has opened its database.
    engine.child.send({ t: 'shutdown', deadlineMs: 2000 });

    expect(await engine.exit).toBe(0);
    expect(await readdir(data)).not.toContain('engine.lock');
  });

  it.skipIf(process.platform === 'win32')(
    'stops on SIGTERM with the same drain',
    async () => {
      const data = await newDir();
      const engine = launch(['--mode=local', '--port=0', `--data-dir=${data}`]);
      await until('engine.ready', () => event(engine, 'engine.ready'));

      engine.child.kill('SIGTERM');

      expect(await engine.exit).toBe(0);
      expect(event(engine, 'engine.stopped')).toMatchObject({
        reason: 'sigterm',
      });
      expect(await readdir(data)).not.toContain('engine.lock');
    },
  );

  it('prints the launch URL once, and its token is in no log line (I-10)', async () => {
    const data = await newDir();
    const engine = launch(['--mode=local', '--port=0', `--data-dir=${data}`]);
    const ready = await until('engine.ready', () =>
      event(engine, 'engine.ready'),
    );
    const url = await until('the launch URL', () =>
      engine.stdout.find((line) => line.startsWith('http://')),
    );

    const token = /#t=([A-Za-z0-9_-]{43})$/.exec(url)?.[1] ?? '';
    const meta = await fetch(
      `http://127.0.0.1:${String(ready.port)}/api/v1/meta`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    const anonymous = await fetch(
      `http://127.0.0.1:${String(ready.port)}/api/v1/meta`,
    );

    expect(url).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:${String(ready.port)}/#t=`),
    );
    expect(meta.status).toBe(200);
    expect(await meta.json()).toMatchObject({
      mode: 'local',
      apiVersion: 'v1',
    });
    expect(anonymous.status).toBe(401);
    expect(engine.stdout.filter((line) => line.includes(token))).toEqual([url]);
    expect(engine.stderr.join('')).not.toContain(token);
  });

  it('serves the live WebSocket from the bundle: a ticket opens a socket and hello gets welcome, a reused ticket is refused', async () => {
    const data = await newDir();
    const engine = launch(['--mode=local', '--port=0', `--data-dir=${data}`]);
    const ready = await until('engine.ready', () =>
      event(engine, 'engine.ready'),
    );
    const url = await until('the launch URL', () =>
      engine.stdout.find((line) => line.startsWith('http://')),
    );
    const token = /#t=([A-Za-z0-9_-]{43})$/.exec(url)?.[1] ?? '';
    const base = `127.0.0.1:${String(ready.port)}`;
    const issue = async (): Promise<string> => {
      const response = await fetch(`http://${base}/api/v1/live/tickets`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      return ((await response.json()) as { ticket: string }).ticket;
    };
    const connect = (ticket: string) =>
      new Promise<'opened' | 'refused'>((resolve) => {
        const socket = new WebSocket(`ws://${base}/api/v1/live`, [
          'app.v1',
          `app.ticket.${ticket}`,
        ]);
        socket.addEventListener('open', () => {
          socket.send(JSON.stringify({ t: 'hello', v: 1 }));
        });
        socket.addEventListener('message', (message) => {
          welcomed.push(
            JSON.parse(String(message.data)) as Record<string, unknown>,
          );
          resolve('opened');
          socket.close();
        });
        socket.addEventListener('error', () => {
          resolve('refused');
        });
      });
    const welcomed: Record<string, unknown>[] = [];
    const ticket = await issue();

    const first = await connect(ticket);
    const again = await connect(ticket);

    expect(first).toBe('opened');
    expect(welcomed[0]).toMatchObject({ t: 'welcome', v: 1 });
    expect(again).toBe('refused');
  });

  it('AC-1 --mode=desktop boots from ctl:init, has no listener, posts ready, and stops on ctl:shutdown', async () => {
    const data = await newDir();
    const engine = launch(['--mode=desktop']);
    engine.child.send({
      t: 'init',
      paths: { data, logs: join(data, 'logs') },
      dek: new Uint8Array(randomBytes(32)),
      settings: {},
    });

    const posted = await until('ctl:ready', () =>
      engine.messages.find((message) => message.t === 'ready'),
    );
    const ready = await until('engine.ready', () =>
      event(engine, 'engine.ready'),
    );
    engine.child.send({ t: 'shutdown', deadlineMs: 2000 });

    expect(posted).toMatchObject({ t: 'ready', contract: ready.contract });
    expect(ready.port).toBeUndefined();
    expect(ready.vault).toBe('unlocked');
    expect(engine.stdout.filter((line) => line.startsWith('http'))).toEqual([]);
    expect(await engine.exit).toBe(0);
    expect(await readdir(data)).not.toContain('engine.lock');
  });

  it('AC-1 --mode=team refuses to start with its own exit code, before it touches the data directory', async () => {
    const data = await newDir();
    const engine = launch(['--mode=team', `--data-dir=${data}`]);

    expect(await engine.exit).toBe(78);
    expect(JSON.parse(engine.stderr.join('').trim())).toMatchObject({
      reason: 'mode-unavailable',
    });
    expect(await readdir(data)).toEqual([]);
  });

  it('M0-59 AC-12 native mode refuses a bind outside loopback with its own exit code and guidance, before it touches the data directory', async () => {
    const data = await newDir();
    const engine = launch([
      '--mode=local',
      '--port=0',
      '--host=0.0.0.0',
      `--data-dir=${data}`,
    ]);

    expect(await engine.exit).toBe(78);
    const failure = JSON.parse(engine.stderr.join('').trim()) as Record<
      string,
      unknown
    >;
    expect(failure).toMatchObject({
      event: 'engine.start.failed',
      reason: 'mode-unavailable',
    });
    expect(String(failure.detail)).toContain('SSH tunnel');
    expect(await readdir(data)).toEqual([]);
    expect(engine.stdout.filter((line) => line.startsWith('http'))).toEqual([]);
  });

  it('M0-59 AC-12 container mode: banner, token on every route, foreign Host refused, healthcheck green, drains on shutdown', async () => {
    const data = await newDir();
    const token = randomBytes(32).toString('base64url');
    const engine = launch(['--mode=local', '--port=0'], {
      APP_RUNTIME: 'container',
      APP_DATA_DIR: data,
      APP_TOKEN: token,
    });
    const ready = await until('engine.ready', () =>
      event(engine, 'engine.ready'),
    );
    const url = await until('the launch URL', () =>
      engine.stdout.find((line) => line.startsWith('http://')),
    );
    const port = Number(ready.port);
    const callWithHost = (host: string, authorized: boolean) =>
      new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          {
            host: '127.0.0.1',
            port,
            path: '/api/v1/meta',
            headers: {
              host,
              ...(authorized ? { authorization: `Bearer ${token}` } : {}),
            },
          },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        );
        request.on('error', reject);
        request.end();
      });

    const banner = engine.stdout
      .filter((line) => !line.startsWith('{'))
      .join('\n');
    expect(banner).toContain(
      `docker run -p 127.0.0.1:${String(port)}:${String(port)}`,
    );
    expect(banner).toContain('--network host');
    expect(url).toBe(`http://127.0.0.1:${String(port)}/#t=${token}`);
    expect(await callWithHost(`127.0.0.1:${String(port)}`, false)).toBe(401);
    expect(await callWithHost('localhost:12345', true)).toBe(200);
    expect(await callWithHost('evil.example', true)).toBe(403);
    expect(await callWithHost('10.0.0.5:8765', true)).toBe(403);
    // The healthcheck the image runs, with the environment of the container.
    const check = spawn(
      process.execPath,
      [join(root, 'apps', 'engine', 'scripts', 'healthcheck.mjs')],
      { env: { ...process.env, APP_PORT: String(port) }, stdio: 'ignore' },
    );
    expect(await new Promise((resolve) => check.on('exit', resolve))).toBe(0);
    // I-10: the token is in the one console line that is meant to hold it, and nowhere else.
    expect(engine.stdout.filter((line) => line.includes(token))).toEqual([url]);
    expect(engine.stderr.join('')).not.toContain(token);

    engine.child.send({ t: 'shutdown', deadlineMs: 2000 });
    expect(await engine.exit).toBe(0);
    expect(await readdir(data)).not.toContain('engine.lock');
  });

  it('M0-59 AC-12 container mode refuses a public origin outside loopback and a made-up runtime, with usage or refusal exit codes', async () => {
    const data = await newDir();
    const origin = launch(['--mode=local', '--port=0'], {
      APP_RUNTIME: 'container',
      APP_DATA_DIR: data,
      APP_PUBLIC_ORIGIN: 'https://portal.example.com',
    });
    const runtime = launch(['--mode=local', '--port=0', `--data-dir=${data}`], {
      APP_RUNTIME: 'cloud9',
    });

    expect(await origin.exit).toBe(78);
    expect(origin.stderr.join('')).toContain('A-12');
    expect(await runtime.exit).toBe(64);
    expect(runtime.stderr.join('')).not.toContain('cloud9');
    expect(await readdir(data)).toEqual([]);
  });

  it('refuses bad flags with a usage error that names the flag', async () => {
    const engine = launch(['--mode=local', '--port=banana']);

    expect(await engine.exit).toBe(64);
    expect(engine.stderr.join('')).toContain('--port');
    expect(engine.stderr.join('')).not.toContain('banana');
  });
});

describe('the metafile', () => {
  const meta = JSON.parse(readFileSync(metafile, 'utf8')) as {
    inputs: Record<string, unknown>;
    outputs: Record<
      string,
      { imports: { path: string; external?: boolean; kind: string }[] }
    >;
  };
  const packageOf = (input: string): string | undefined => {
    const match =
      /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)\//.exec(
        input.replaceAll('\\', '/'),
      );
    return match?.[1];
  };

  it('AC-2 lists every package the bundle contains, and the bundle imports no other package', () => {
    const bundled = new Set(
      Object.keys(meta.inputs).flatMap((input) => packageOf(input) ?? []),
    );
    const external = new Set(
      Object.values(meta.outputs).flatMap((output) =>
        output.imports
          .filter((entry) => entry.external === true)
          .map((entry) => entry.path),
      ),
    );

    for (const expected of ['fastify', 'kysely', 'pino', 'ws', 'zod', 'pg']) {
      expect(bundled).toContain(expected);
    }
    // Everything the bundle loads at run time is Node itself: nothing is resolved from a
    // node_modules next to the bundle (the optional native add-ons are stubbed out at build time).
    const builtins = new Set(
      builtinModules.map((name) => name.replace(/^node:/, '')),
    );
    expect(
      [...external]
        .map((path) => path.replace(/^node:/, ''))
        .filter((path) => !builtins.has(path))
        .sort(),
    ).toEqual([]);
  });

  it('AC-2 lists the engine sources, mode files included, so a reviewer can see where mode logic lives', () => {
    const own = Object.keys(meta.inputs).map((input) =>
      input.replaceAll('\\', '/'),
    );

    for (const file of [
      'apps/engine/src/compose-core.ts',
      'apps/engine/src/modes/desktop.ts',
      'apps/engine/src/modes/local.ts',
      'apps/engine/src/modes/team.ts',
    ]) {
      expect(own).toContain(file);
    }
  });
});
