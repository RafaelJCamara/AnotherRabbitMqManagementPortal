// The container HEALTHCHECK client (`scripts/healthcheck.mjs`), run as the image runs it: as a
// process, with the environment of the container, against a container-mode engine and against
// stand-ins that answer badly.
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  startForTest,
  tempDir,
  type RunningEngine,
  type TempDir,
} from './testing/harness.ts';

const script = fileURLToPath(
  new URL('../scripts/healthcheck.mjs', import.meta.url),
);

const engines: RunningEngine[] = [];
const servers: Server[] = [];
const dirs: TempDir[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.engine.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  for (const dir of dirs.splice(0)) await dir.cleanup();
});

function run(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    // The operating system's own variables stay (Windows needs SystemRoot); the container's do not.
    const base = { ...process.env };
    delete base.APP_PORT;
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...base, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('exit', (code) => {
      resolve({ code, stderr, stdout });
    });
  });
}

async function standIn(
  answer: (response: import('node:http').ServerResponse) => void,
): Promise<number> {
  const server = createServer((_request, response) => {
    answer(response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function containerEngine(): Promise<number> {
  const dir = await tempDir('engine-health-');
  dirs.push(dir);
  const engine = await startForTest(['--mode=local', '--port=0'], undefined, {
    env: { APP_RUNTIME: 'container', APP_DATA_DIR: dir.dir },
  });
  engines.push(engine);
  return engine.engine.address?.port ?? 0;
}

describe('the container healthcheck', () => {
  it('M0-59 AC-11 exits 0 against a container-mode engine, by APP_PORT or --port, and prints nothing', async () => {
    const port = await containerEngine();

    const byEnv = await run([], { APP_PORT: String(port) });
    const byFlag = await run([`--port=${String(port)}`], { APP_PORT: '1' });

    expect(byEnv).toEqual({ code: 0, stderr: '', stdout: '' });
    expect(byFlag.code).toBe(0);
  });

  it('M0-59 AC-11 exits 1 with one short line when nothing listens', async () => {
    const port = await standIn((response) => response.end());
    for (const server of servers.splice(0)) {
      await new Promise((resolve) => server.close(resolve));
    }

    const result = await run([], { APP_PORT: String(port) });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^unhealthy: .+\n$/);
  });

  it('M0-59 AC-11 exits 1 for a status other than 200, an answer that is not ok, and one that is not JSON', async () => {
    const wrong503 = await standIn((response) => {
      response.statusCode = 503;
      response.end('{"status":"ok"}');
    });
    const notOk = await standIn((response) => {
      response.end('{"status":"starting"}');
    });
    const notJson = await standIn((response) => {
      response.end('<html>');
    });
    const huge = await standIn((response) => {
      response.end('x'.repeat(5000));
    });

    for (const port of [wrong503, notOk, notJson, huge]) {
      const result = await run([], { APP_PORT: String(port) });
      expect(result.code, String(port)).toBe(1);
      expect(result.stderr).toMatch(/^unhealthy: /);
    }
  });

  it('M0-59 AC-11 gives up at its timeout instead of waiting for an engine that never answers', async () => {
    const port = await standIn(() => undefined);
    const started = Date.now();

    const result = await run(
      [`--port=${String(port)}`, '--timeout-ms=300'],
      {},
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('no answer in time');
    // Minimum-based on purpose: a loaded runner may be slow to start the process, never faster.
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it('M0-59 AC-11 contacts 127.0.0.1 whatever the environment says, and refuses a bad port', async () => {
    const port = await standIn((response) => {
      response.end('{"status":"ok"}');
    });

    const elsewhere = await run([], {
      APP_PORT: String(port),
      APP_HOST: '10.255.255.1',
      HTTP_PROXY: 'http://10.255.255.1:3128',
    });
    const bad = await run([], { APP_PORT: '99999' });
    const words = await run([], { APP_PORT: 'eight' });

    expect(elsewhere.code).toBe(0);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('port');
    expect(words.code).toBe(1);
  });
});
