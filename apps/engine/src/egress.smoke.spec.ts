// `nx run engine:smoke` and `nx run engine:egress` (M0-69, I-12): the built engine bundle runs under
// the egress guard (src/testing/egress-guard.mjs), which refuses and records every connection, name
// lookup, datagram socket and child process. The soak exercises the engine with nothing configured
// and requires that the guard saw none of them. `engine:egress` sets EGRESS_SOAK_SECONDS=600 for the
// ten minutes of the acceptance criterion; `engine:smoke` runs the same test for a short while.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const bundle = join(root, 'dist', 'apps', 'engine', 'main.mjs');
const metafile = join(root, 'dist', 'apps', 'engine', 'meta.json');
const guard = pathToFileURL(
  fileURLToPath(new URL('./testing/egress-guard.mjs', import.meta.url)),
).href;

const SOAK_SECONDS = Math.max(
  3,
  Number(process.env.EGRESS_SOAK_SECONDS ?? '15'),
);

const dirs: string[] = [];
const children: ChildProcess[] = [];
const servers: Server[] = [];

async function newDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'engine-egress-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

interface GuardEntry {
  readonly kind: string;
  readonly detail: string;
}

function guardLog(path: string): GuardEntry[] {
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as GuardEntry)
    : [];
}

/** The things the guard must refuse, tried in a process that has it, against a real local server. */
const PROBE = `
import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import tls from 'node:tls';
import http from 'node:http';
import http2 from 'node:http2';
import { spawn } from 'node:child_process';

const port = Number(process.argv[2]);
const out = {};
const code = (error) => error?.cause?.code ?? error?.code ?? error?.name ?? 'unknown';
async function attempt(name, work) {
  try {
    await work();
    out[name] = 'allowed';
  } catch (error) {
    out[name] = code(error);
  }
}
await attempt('net', () => net.connect(port, '127.0.0.1'));
await attempt('net-path', () => net.connect('/tmp/not-a-socket'));
await attempt('http', () => new Promise((resolve, reject) => {
  const request = http.get('http://127.0.0.1:' + port + '/', resolve);
  request.on('error', reject);
}));
await attempt('fetch', () => fetch('http://127.0.0.1:' + port + '/'));
await attempt('dns.lookup', () => new Promise((resolve, reject) => {
  dns.lookup('example.test', (error) => (error ? reject(error) : resolve()));
}));
await attempt('dns.promises', () => dns.promises.resolve4('example.test'));
await attempt('dns.resolver', () => new dns.Resolver().resolve4('example.test', () => undefined));
await attempt('dgram', () => dgram.createSocket('udp4'));
await attempt('spawn', () => spawn(process.execPath, ['-e', '0']));
await attempt('tls', () => tls.connect(port, '127.0.0.1'));
await attempt('http2', () => http2.connect('http://127.0.0.1:' + port));
// What stays possible: listening on loopback, and an IP literal is not a lookup.
const server = net.createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
server.close();
out.listen = 'ok';
await new Promise((resolve) => dns.lookup('127.0.0.1', (error) => { out.ipLiteral = error ? 'refused' : 'ok'; resolve(); }));
console.log(JSON.stringify(out));
`;

describe('the egress guard', () => {
  it('AC-1 refuses and records every way out, and a real server never sees a connection', async () => {
    const dir = await newDir();
    let accepted = 0;
    const server = createServer((socket) => {
      accepted += 1;
      socket.destroy();
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as { port: number }).port;
    const script = join(dir, 'probe.mjs');
    const log = join(dir, 'guard.jsonl');
    await writeFile(script, PROBE);

    const child = spawn(
      process.execPath,
      ['--import', guard, script, String(port)],
      {
        env: { ...process.env, EGRESS_GUARD_LOG: log },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    children.push(child);
    let stdout = '';
    child.stdout.on(
      'data',
      (chunk: Buffer) => (stdout += chunk.toString('utf8')),
    );
    const exit = await new Promise<number | null>((resolve) =>
      child.on('exit', resolve),
    );

    expect(exit).toBe(0);
    expect(JSON.parse(stdout) as unknown).toEqual({
      net: 'EGRESS_GUARD',
      'net-path': 'EGRESS_GUARD',
      http: 'EGRESS_GUARD',
      fetch: 'EGRESS_GUARD',
      'dns.lookup': 'EGRESS_GUARD',
      'dns.promises': 'EGRESS_GUARD',
      'dns.resolver': 'EGRESS_GUARD',
      dgram: 'EGRESS_GUARD',
      spawn: 'EGRESS_GUARD',
      tls: 'EGRESS_GUARD',
      http2: 'EGRESS_GUARD',
      listen: 'ok',
      ipLiteral: 'ok',
    });
    const kinds = new Set(guardLog(log).map((entry) => entry.kind));
    for (const kind of [
      'guard.loaded',
      'net.connect',
      'dns.lookup',
      'dns.resolve4',
      'dgram.createSocket',
      'child_process.spawn',
      'tls.connect',
      'http2.connect',
    ]) {
      expect(kinds).toContain(kind);
    }
    // Refused, not just recorded: nothing reached the server.
    expect(accepted).toBe(0);
  });
});

interface Running {
  readonly child: ChildProcess;
  readonly stdout: string[];
  readonly exit: Promise<number | null>;
}

function launch(args: string[], log: string): Running {
  const child = spawn(process.execPath, ['--import', guard, bundle, ...args], {
    env: { ...process.env, EGRESS_GUARD_LOG: log },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.push(child);
  const stdout: string[] = [];
  let pending = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    stdout.push(...lines);
  });
  child.stderr?.on('data', () => undefined);
  const exit = new Promise<number | null>((resolve) =>
    child.on('exit', resolve),
  );
  return { child, stdout, exit };
}

async function until<T>(
  what: string,
  probe: () => T | undefined,
  timeoutMs = 30_000,
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

describe('@egress the engine with no broker configured', () => {
  it(
    `AC-1 zero outbound connections, name lookups, datagram sockets or child processes in ${String(SOAK_SECONDS)} s of use`,
    async () => {
      const data = await newDir();
      const log = join(data, 'guard.jsonl');
      const engine = launch(
        ['--mode=local', '--port=0', `--data-dir=${data}`],
        log,
      );
      const ready = (await until('engine.ready', () =>
        engine.stdout
          .filter((line) => line.startsWith('{'))
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .find((line) => line.event === 'engine.ready'),
      )) as { port: number };
      const url = await until('the launch URL', () =>
        engine.stdout.find((line) => line.startsWith('http://')),
      );
      const token = /#t=([A-Za-z0-9_-]{43})$/.exec(url)?.[1] ?? '';
      const base = `http://127.0.0.1:${String(ready.port)}`;
      const headers = {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      };
      let calls = 0;
      let bundles = 0;
      const post = async (path: string, body: unknown): Promise<number> => {
        calls += 1;
        const response = await fetch(`${base}${path}`, {
          method: 'POST',
          headers: {
            ...headers,
            'idempotency-key': `egress-soak-${String(calls)}`,
          },
          body: JSON.stringify(body),
        });
        await response.arrayBuffer();
        return response.status;
      };

      // What a person does with an engine that has no broker: look at it, arm and lock a
      // connection, export a diagnostics bundle, over and over, for the length of the soak.
      const until_ = Date.now() + SOAK_SECONDS * 1000;
      const bundleEvery = Math.max(5000, (SOAK_SECONDS * 1000) / 10);
      let lastBundle = 0;
      const statuses = new Set<number>();
      while (Date.now() < until_) {
        statuses.add((await fetch(`${base}/healthz`)).status);
        statuses.add((await fetch(`${base}/readyz`)).status);
        statuses.add((await fetch(`${base}/api/v1/meta`, { headers })).status);
        await post('/api/v1/connections/c1/arm', {});
        await post('/api/v1/connections/c1/disarm', {});
        if (Date.now() - lastBundle >= bundleEvery && bundles < 15) {
          lastBundle = Date.now();
          bundles += 1;
          expect(
            await post('/api/v1/diagnostics/bundle', {
              fileToken: `egress-soak-bundle-${String(bundles).padStart(4, '0')}`,
            }),
          ).toBe(200);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      engine.child.send({ t: 'shutdown', deadlineMs: 2000 });
      const code = await engine.exit;

      expect(code).toBe(0);
      expect([...statuses]).toEqual([200]);
      expect(calls).toBeGreaterThan(SOAK_SECONDS);
      expect(bundles).toBeGreaterThan(0);
      const entries = guardLog(log);
      // The guard really ran in the engine, once, and refused nothing.
      expect(
        entries.filter((entry) => entry.kind === 'guard.loaded'),
      ).toHaveLength(1);
      expect(entries.filter((entry) => entry.kind !== 'guard.loaded')).toEqual(
        [],
      );
      const lines = await readFile(log, 'utf8');
      expect(lines).not.toContain('EGRESS_GUARD');
    },
    (SOAK_SECONDS + 90) * 1000,
  );
});

describe('the bundle carries no telemetry or updater', () => {
  const meta = JSON.parse(readFileSync(metafile, 'utf8')) as {
    inputs: Record<string, unknown>;
  };
  const inputs = Object.keys(meta.inputs).map((input) =>
    input.replaceAll('\\', '/'),
  );

  it('AC-1 no analytics, crash-reporting, tracing or update package is bundled', () => {
    const banned =
      /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(?:@sentry|@opentelemetry|@datadog|@bugsnag|@segment|@amplitude|@microsoft\/applicationinsights|dd-trace|newrelic|posthog-node|mixpanel|rollbar|honeybadger|raygun|logrocket|electron-updater|update-electron-app|electron-log)[/-]/;

    // The pattern sees such a package under a pnpm store path and under a flat one.
    for (const sample of [
      'node_modules/.pnpm/@sentry+node@8.0.0/node_modules/@sentry/node/build/index.js',
      'node_modules/electron-updater/out/main.js',
      'node_modules/.pnpm/posthog-node@4.0.0/node_modules/posthog-node/lib/index.js',
      'node_modules/@opentelemetry/api/build/src/index.js',
    ]) {
      expect(banned.test(sample)).toBe(true);
    }
    expect(
      banned.test(
        'node_modules/.pnpm/fastify@5.0.0/node_modules/fastify/fastify.js',
      ),
    ).toBe(false);
    expect(inputs.filter((input) => banned.test(input))).toEqual([]);
    // The check can see packages: the bundle does contain some.
    expect(inputs.some((input) => input.includes('node_modules/'))).toBe(true);
  });
});
