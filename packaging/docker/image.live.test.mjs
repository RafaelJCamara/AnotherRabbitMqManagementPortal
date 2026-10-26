// M0-64: the live checks of the container image. They run the built image (the `product-local` tag
// of `pnpm nx run docker:build`, or DOCKER_IMAGE) with a Docker daemon and prove what the static
// checks cannot: the process is not root, the root filesystem is read-only and the engine still
// serves, SIGTERM ends it within 2 s, the image holds what it should and nothing else.
//
// Without a daemon, or without the image, every test here is skipped and the run says so on stderr:
// nothing was proved. DOCKER_REQUIRE=1 (the image workflow sets it) makes that a failure.
//
//   pnpm nx run docker:test
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { after, describe, it } from 'node:test';

import {
  IMAGE,
  daemonAnswers,
  imageExists,
  required,
  skipped,
} from './daemon.mjs';

const reason = !daemonAnswers()
  ? 'no Docker daemon answers'
  : !imageExists()
    ? `the image ${IMAGE} does not exist (run pnpm nx run docker:build)`
    : undefined;
if (reason !== undefined)
  process.stderr.write(`${skipped('live tests', reason)}\n`);

const TOKEN = randomBytes(32).toString('base64url');
const prefix = `m0-64-${String(process.pid)}`;
const containers = [];
const volumes = [];
let counter = 0;

/** Runs `docker <args>` and returns stdout; a failure throws with the command's stderr. */
function docker(args, { timeout = 120_000, input } = {}) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    timeout,
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/** The same, returning the exit status instead of throwing. */
function dockerStatus(args, timeout = 60_000) {
  try {
    docker(args, { timeout });
    return 0;
  } catch (error) {
    return typeof error.status === 'number' ? error.status : 1;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The hardened flags of the compose file, plus a fresh data volume. */
function hardenedRun(extra = []) {
  counter += 1;
  const name = `${prefix}-${String(counter)}`;
  const volume = `${name}-data`;
  containers.push(name);
  volumes.push(volume);
  docker(
    [
      'run',
      '--detach',
      '--name',
      name,
      '--read-only',
      '--tmpfs',
      '/tmp:size=64m,mode=1777',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--volume',
      `${volume}:/data`,
      '--env',
      `APP_TOKEN=${TOKEN}`,
      ...extra,
      IMAGE,
    ],
    { timeout: 120_000 },
  );
  return name;
}

function hostPort(name) {
  const mapping = docker(['port', name, '8765/tcp']).split('\n')[0];
  const port = Number(mapping.slice(mapping.lastIndexOf(':') + 1));
  assert.ok(
    Number.isInteger(port) && port > 0,
    `no published port: ${mapping}`,
  );
  return port;
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const call = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { host: `127.0.0.1:${String(port)}`, ...headers },
        timeout: 5000,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    call.on('timeout', () => call.destroy(new Error('timeout')));
    call.on('error', reject);
    call.end();
  });
}

/** Polls /healthz through the published port until the engine answers 200 (at most 60 s). */
async function untilServing(name) {
  const port = hostPort(name);
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const answer = await get(port, '/healthz');
      if (answer.status === 200) return port;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the engine did not serve within 60 s. Logs:\n${docker(['logs', '--tail', '40', name])}`,
      );
    }
    await sleep(500);
  }
}

after(() => {
  for (const name of containers)
    dockerStatus(['rm', '--force', '--volumes', name]);
  for (const volume of volumes)
    dockerStatus(['volume', 'rm', '--force', volume]);
});

// With DOCKER_REQUIRE=1 the block below fails once instead of five skipped tests passing silently.
const live = { skip: reason ?? false };

if (reason !== undefined && required()) {
  describe('M0-64 live image (required)', () => {
    it('AC-7 a Docker daemon and the image are present', () => {
      assert.fail(skipped('live tests', reason));
    });
  });
}

describe('M0-64 live image', live, () => {
  it('AC-7 runs as the non-root user with a read-only root filesystem, serves, and writes only to /data and /tmp', async () => {
    const name = hardenedRun(['--publish', '127.0.0.1::8765']);
    const port = await untilServing(name);

    const config = JSON.parse(
      docker(['inspect', '--format', '{{json .}}', name]),
    );
    assert.equal(config.Config.User, '65532:65532');
    assert.equal(config.HostConfig.ReadonlyRootfs, true);
    assert.ok(config.Config.Env.includes('APP_RUNTIME=container'));
    assert.deepEqual(config.Config.Healthcheck.Test.slice(-2), [
      '/nodejs/bin/node',
      '/app/engine/healthcheck.mjs',
    ]);
    assert.match(
      docker(['image', 'inspect', '--format', '{{.Architecture}}', IMAGE]),
      /^(amd64|arm64)$/,
    );

    // The process really is not root, and /data (the volume) is where the engine keeps its files.
    assert.equal(
      docker([
        'exec',
        name,
        '/nodejs/bin/node',
        '-e',
        'process.stdout.write(String(process.getuid()))',
      ]),
      '65532',
    );
    assert.notEqual(
      docker([
        'exec',
        name,
        '/nodejs/bin/node',
        '-e',
        "process.stdout.write(String(require('node:fs').readdirSync('/data').length))",
      ]),
      '0',
      'the engine opened its data directory',
    );
    assert.equal(
      docker(['diff', name]),
      '',
      'nothing was written to the root filesystem',
    );

    // The HEALTHCHECK client the image ships exits 0 against this engine.
    assert.equal(
      dockerStatus([
        'exec',
        name,
        '/nodejs/bin/node',
        '/app/engine/healthcheck.mjs',
      ]),
      0,
    );

    // ADR-016: the token is mandatory, and a foreign Host is refused.
    assert.deepEqual(JSON.parse((await get(port, '/healthz')).body), {
      status: 'ok',
    });
    assert.equal((await get(port, '/api/v1/meta')).status, 401);
    assert.equal(
      (await get(port, '/api/v1/meta', { authorization: `Bearer ${TOKEN}` }))
        .status,
      200,
    );
    assert.equal(
      (await get(port, '/healthz', { host: 'evil.example' })).status,
      403,
    );

    // The launch URL and the loopback publish advice are printed once; the token is in the fragment.
    const logs = docker(['logs', name]);
    assert.match(logs, /docker run -p 127\.0\.0\.1:8765:8765/);
    assert.match(logs, /#t=/);
  });

  it('AC-8 drains and exits 0 within 2 s of SIGTERM', async () => {
    const name = hardenedRun(['--publish', '127.0.0.1::8765']);
    await untilServing(name);
    const started = performance.now();
    docker(['kill', '--signal', 'SIGTERM', name]);
    const exitCode = docker(['wait', name], { timeout: 30_000 });
    const elapsedMs = performance.now() - started;
    assert.equal(exitCode, '0');
    assert.ok(
      elapsedMs < 2000,
      `exited after ${String(Math.round(elapsedMs))} ms`,
    );
    assert.match(docker(['logs', name]), /engine\.stopped/);
  });

  it('AC-9 holds the bundle, the web build, the healthcheck and the licences, and no shell, source map or key', () => {
    const script = `
      const fs = require('node:fs');
      const path = require('node:path');
      const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
      const files = walk('/app');
      const out = {
        files: files.filter((f) => /main\\.mjs$|healthcheck\\.mjs$|index\\.html$|capture\\.mjs$/.test(f)),
        maps: files.filter((f) => f.endsWith('.map') || f.endsWith('meta.json')),
        secrets: files.filter((f) => /\\.(pem|key|kek)$|(^|\\/)\\.env/.test(f)),
        shells: ['/bin/sh', '/bin/bash', '/usr/bin/sh', '/busybox/sh'].filter((f) => fs.existsSync(f)),
        licences: ['/licenses/LICENSE', '/licenses/NOTICE', '/licenses/web-3rdpartylicenses.txt'].filter((f) => fs.existsSync(f)),
        dataUid: fs.statSync('/data').uid,
        appUid: fs.statSync('/app').uid,
      };
      process.stdout.write(JSON.stringify(out));`;
    const found = JSON.parse(
      docker([
        'run',
        '--rm',
        '--entrypoint',
        '/nodejs/bin/node',
        IMAGE,
        '-e',
        script,
      ]),
    );
    assert.deepEqual(found.files.sort(), [
      '/app/engine/healthcheck.mjs',
      '/app/engine/main.mjs',
      '/app/engine/workers/capture.mjs',
      '/app/web/browser/index.html',
    ]);
    assert.deepEqual(found.maps, []);
    assert.deepEqual(found.secrets, []);
    assert.deepEqual(found.shells, []);
    assert.deepEqual(found.licences.sort(), [
      '/licenses/LICENSE',
      '/licenses/NOTICE',
      '/licenses/web-3rdpartylicenses.txt',
    ]);
    assert.equal(found.dataUid, 65532);
    assert.equal(found.appUid, 0, 'the application tree is root-owned');
  });

  it('AC-10 starts and answers its healthcheck with no network at all (--network none)', async () => {
    const name = hardenedRun(['--network', 'none']);
    const deadline = Date.now() + 60_000;
    while (
      dockerStatus([
        'exec',
        name,
        '/nodejs/bin/node',
        '/app/engine/healthcheck.mjs',
      ]) !== 0
    ) {
      if (Date.now() > deadline) {
        throw new Error(
          `not healthy without a network. Logs:\n${docker(['logs', '--tail', '40', name])}`,
        );
      }
      await sleep(500);
    }
    const networks = JSON.parse(
      docker([
        'inspect',
        '--format',
        '{{json .NetworkSettings.Networks}}',
        name,
      ]),
    );
    assert.deepEqual(Object.keys(networks), ['none']);
  });

  it('AC-11 refuses a misspelt APP_ setting with a usage error and never prints its value', () => {
    const marker = `marker-${randomBytes(6).toString('hex')}`;
    let status = 0;
    let stderr = '';
    try {
      execFileSync(
        'docker',
        ['run', '--rm', '--read-only', '--env', `APP_BOGUS=${marker}`, IMAGE],
        {
          encoding: 'utf8',
          timeout: 60_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    } catch (error) {
      status = error.status;
      stderr = `${error.stderr ?? ''}${error.stdout ?? ''}`;
    }
    assert.equal(status, 64);
    assert.ok(!stderr.includes(marker), 'the value is not echoed');
  });
});
