// Local web mode and container mode started the way the bundle starts them, and then asked
// questions on a real socket: who may call it, as what Host, with which Origin, and what it prints.
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AppError, createLogger } from '@app/kernel';
import { afterEach, describe, expect, it } from 'vitest';

import { composeEngine } from '../compose-core.ts';
import { UsageError } from '../entry/args.ts';
import {
  localArgs,
  rawRequest,
  startForTest,
  tempDir,
  type RunningEngine,
  type TempDir,
} from '../testing/harness.ts';
import { createLocalMode } from './local.ts';
import { ModeRefusedError } from './types.ts';

const made: TempDir[] = [];
const open: RunningEngine[] = [];
async function dir(): Promise<string> {
  const temp = await tempDir('engine-web-');
  made.push(temp);
  return temp.dir;
}
afterEach(async () => {
  for (const running of open.splice(0)) await running.engine.close();
  for (const temp of made.splice(0)) await temp.cleanup();
});

const TOKEN = 'T'.repeat(16) + 't'.repeat(16) + '0123456789';
const bearer = (token: string | undefined) => ({
  authorization: `Bearer ${token ?? ''}`,
});

async function startNative(
  extra: readonly string[] = [],
  opener?: (url: string) => Promise<void>,
): Promise<RunningEngine> {
  const running = await startForTest(
    localArgs(await dir(), extra),
    undefined,
    opener === undefined ? {} : { openBrowser: opener },
  );
  open.push(running);
  return running;
}

/** A container-mode engine bound on the wildcard, as in a container, reached through loopback. */
async function startContainer(
  extra: readonly string[] = [],
  env: Record<string, string> = {},
): Promise<RunningEngine> {
  const running = await startForTest(
    ['--mode=local', '--port=0', ...extra],
    undefined,
    { env: { APP_RUNTIME: 'container', APP_DATA_DIR: await dir(), ...env } },
  );
  open.push(running);
  return running;
}

const portOf = (running: RunningEngine): number =>
  running.engine.address?.port ?? 0;

describe('native local web mode', () => {
  it('M0-59 AC-1 binds loopback, prints one launch URL with the token in the fragment, opens nothing, and logs no token', async () => {
    let opened = 0;
    const running = await startNative([], () => {
      opened += 1;
      return Promise.resolve();
    });

    const text = running.consoleText.join('');
    expect(running.engine.address?.host).toBe('127.0.0.1');
    expect(text).toBe(
      `http://127.0.0.1:${String(portOf(running))}/#t=${running.token ?? ''}\n`,
    );
    expect(running.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(opened).toBe(0);
    expect(running.lines.join('\n')).not.toContain(running.token ?? '?');
    expect(running.lines.join('\n')).toContain('"authSource":"generated"');
  });

  it('M0-59 AC-2 refuses a bind outside loopback before it creates a file, takes a lock or binds a socket', async () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.20', 'example.com']) {
      const data = await dir();

      const failure = await startForTest([
        ...localArgs(data),
        `--host=${host}`,
      ]).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ModeRefusedError);
      expect((failure as Error).message).toContain('SSH tunnel');
      expect(await readdir(data)).toEqual([]);
    }
  });

  it('M0-59 AC-3 answers a foreign Origin, a foreign Host and a cross-site fetch with 403, sends no CORS header, and changes nothing', async () => {
    const running = await startNative();
    const port = portOf(running);
    const auth = bearer(running.token);

    const same = await rawRequest(port, '/api/v1/meta', {
      ...auth,
      host: `127.0.0.1:${String(port)}`,
      origin: `http://127.0.0.1:${String(port)}`,
    });
    const foreignOrigin = await rawRequest(port, '/api/v1/meta', {
      ...auth,
      origin: 'https://evil.example',
    });
    const otherLocalSite = await rawRequest(port, '/api/v1/meta', {
      ...auth,
      origin: 'http://127.0.0.1:1',
    });
    const nullOrigin = await rawRequest(port, '/api/v1/meta', {
      ...auth,
      origin: 'null',
    });
    const foreignHost = await rawRequest(port, '/api/v1/meta', {
      ...auth,
      host: 'evil.example',
    });
    const crossSite = await rawRequest(port, '/api/v1/meta', {
      ...auth,
      'sec-fetch-site': 'cross-site',
    });

    expect(same.status).toBe(200);
    for (const refused of [
      foreignOrigin,
      otherLocalSite,
      nullOrigin,
      foreignHost,
      crossSite,
    ]) {
      expect(refused.status).toBe(403);
    }
    for (const response of [same, foreignOrigin, foreignHost, crossSite]) {
      expect(
        Object.keys(response.headers).filter((name) =>
          name.startsWith('access-control-'),
        ),
      ).toEqual([]);
    }
  });

  it('M0-59 AC-4 --token-file is the token: Bearer 200 with it, 401 with anything else', async () => {
    const data = await dir();
    const file = join(data, 'launch-token');
    await writeFile(file, `${TOKEN}\n`, { mode: 0o600 });

    const running = await startForTest([
      '--mode=local',
      '--port=0',
      `--data-dir=${join(data, 'state')}`,
      `--token-file=${file}`,
    ]);
    open.push(running);
    const port = portOf(running);

    expect(running.token).toBe(TOKEN);
    expect((await rawRequest(port, '/api/v1/meta', bearer(TOKEN))).status).toBe(
      200,
    );
    expect(
      (await rawRequest(port, '/api/v1/meta', bearer(`${TOKEN}x`))).status,
    ).toBe(401);
    expect(running.lines.join('\n')).not.toContain(TOKEN);
    expect(running.lines.join('\n')).toContain('"authSource":"file"');
  });

  it('M0-59 AC-4 a missing token file stops the start with a usage error and creates nothing', async () => {
    const data = await dir();

    const failure = await startForTest([
      ...localArgs(data),
      `--token-file=${join(data, 'absent')}`,
    ]).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UsageError);
    expect((failure as Error).message).not.toContain(data);
    expect(await readdir(data)).toEqual([]);
  });

  it('M0-59 AC-5 --open calls the opener once, after the listener is up, with the launch URL; without it never', async () => {
    const urls: string[] = [];
    let listening = false;

    const running = await startNative(['--open'], (url) => {
      urls.push(url);
      // The URL is only usable if the engine already answers on it.
      listening = true;
      return Promise.resolve();
    });

    expect(listening).toBe(true);
    expect(urls).toEqual([
      `http://127.0.0.1:${String(portOf(running))}/#t=${running.token ?? ''}`,
    ]);
    expect(running.consoleText.join('')).toContain(urls[0] ?? '?');
  });

  it('M0-59 AC-5 a browser that cannot be opened is a warning without the token, and the engine keeps serving', async () => {
    const running = await startNative(['--open'], () =>
      Promise.reject(new Error('No program could open the browser.')),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect((await rawRequest(portOf(running), '/healthz')).status).toBe(200);
    expect(running.lines.join('\n')).toContain('engine.open.failed');
    expect(running.lines.join('\n')).not.toContain(running.token ?? '?');
  });

  it('M0-59 AC-5 --open together with --no-open is a usage error', async () => {
    await expect(
      startForTest([...localArgs(await dir()), '--open', '--no-open']),
    ).rejects.toBeInstanceOf(UsageError);
  });
});

describe('container mode (ADR-016)', () => {
  it('M0-59 AC-7 builds a wildcard listener marked as the container namespace, with one token authenticator', async () => {
    const { profile } = await createLocalMode({
      args: { mode: 'local' },
      ctl: undefined,
      bundleDir: '',
      logger: createLogger({ level: 'silent' }),
      env: { runtime: 'container' },
    });

    expect(profile.listener).toEqual({
      host: '0.0.0.0',
      port: 8765,
      containerNamespace: true,
    });
    expect(profile.authenticators).toHaveLength(1);
    expect(profile.storage.lockDir).toBe('/data');
  });

  it('M0-59 AC-7 requires the token on every route that needs a principal, and a made token is not guessable from the boot', async () => {
    const running = await startContainer();
    const port = portOf(running);

    expect(running.engine.address?.host).toBe('0.0.0.0');
    for (const path of ['/api/v1/meta', '/api/v1/connections']) {
      expect((await rawRequest(port, path)).status).toBe(401);
      expect((await rawRequest(port, path, bearer('wrong'))).status).toBe(401);
      expect(
        (await rawRequest(port, path, bearer(`${running.token ?? ''}x`)))
          .status,
      ).toBe(401);
    }
    expect(
      (await rawRequest(port, '/api/v1/meta', bearer(running.token))).status,
    ).toBe(200);
    expect(running.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('M0-59 AC-7 uses the token it is given by APP_TOKEN or APP_TOKEN_FILE', async () => {
    const fromEnv = await startContainer([], { APP_TOKEN: TOKEN });
    expect(fromEnv.token).toBe(TOKEN);
    expect(
      (await rawRequest(portOf(fromEnv), '/api/v1/meta', bearer(TOKEN))).status,
    ).toBe(200);

    const data = await dir();
    const file = join(data, 'secret');
    await writeFile(file, `${TOKEN}Z\n`);
    const fromFile = await startContainer([], { APP_TOKEN_FILE: file });
    expect(fromFile.token).toBe(`${TOKEN}Z`);
    expect(
      (await rawRequest(portOf(fromFile), '/api/v1/meta', bearer(`${TOKEN}Z`)))
        .status,
    ).toBe(200);
    for (const running of [fromEnv, fromFile]) {
      expect(running.lines.join('\n')).not.toContain(TOKEN);
    }
  });

  it('M0-59 AC-8 accepts loopback Host names on any port and refuses every other Host', async () => {
    const running = await startContainer();
    const port = portOf(running);
    const call = (
      host: string | undefined,
      extra: Record<string, string> = {},
    ) =>
      rawRequest(port, '/api/v1/meta', {
        ...bearer(running.token),
        ...(host === undefined ? {} : { host }),
        ...extra,
      });

    for (const host of [
      '127.0.0.1:8765',
      '127.0.0.1:9000',
      'localhost:49152',
      'localhost',
      '[::1]:1',
    ]) {
      expect((await call(host)).status, host).toBe(200);
    }
    for (const host of [
      'evil.example',
      'evil.example:8765',
      '127.0.0.1.evil.example:8765',
      'localhost.evil.example',
      '10.0.0.5:8765',
      '0.0.0.0:8765',
      '127.0.0.1:99999',
    ]) {
      expect((await call(host)).status, host).toBe(403);
    }
  });

  it('M0-59 AC-8 compares the Origin with the same set: only this Host spelled as an origin', async () => {
    const running = await startContainer();
    const call = (host: string, origin: string) =>
      rawRequest(portOf(running), '/api/v1/meta', {
        ...bearer(running.token),
        host,
        origin,
      });

    expect((await call('127.0.0.1:9000', 'http://127.0.0.1:9000')).status).toBe(
      200,
    );
    expect((await call('localhost:9000', 'http://localhost:9000')).status).toBe(
      200,
    );
    expect((await call('127.0.0.1:9000', 'http://127.0.0.1:8765')).status).toBe(
      403,
    );
    expect((await call('127.0.0.1:9000', 'https://evil.example')).status).toBe(
      403,
    );
    expect((await call('127.0.0.1:9000', 'null')).status).toBe(403);
  });

  it('M0-59 AC-8 a loopback public origin is accepted as a Host and nothing near it is', async () => {
    const running = await startContainer([
      '--public-origin=http://localhost:9000',
    ]);

    const call = (host: string) =>
      rawRequest(portOf(running), '/healthz', { host });

    expect((await call('localhost:9000')).status).toBe(200);
    expect((await call('localhost:9001')).status).toBe(200);
    expect((await call('portal.localhost:9000')).status).toBe(403);
  });

  it('M0-59 AC-8 composeEngine still refuses a wildcard bind that is not marked as the container namespace, or has no authenticator', async () => {
    const { profile } = await createLocalMode({
      args: { mode: 'local', dataDir: await dir(), port: 0 },
      ctl: undefined,
      bundleDir: '',
      logger: createLogger({ level: 'silent' }),
    });
    const data = await dir();
    const tryCompose = (change: object) =>
      composeEngine({
        profile: {
          ...profile,
          storage: { ...profile.storage, lockDir: data },
          ...change,
        },
        modules: () => [],
        engineVersion: '0.0.0',
        logger: createLogger({ level: 'silent' }),
      }).catch((error: unknown) => error);

    const unmarked = await tryCompose({
      listener: { host: '0.0.0.0', port: 0 },
    });
    const noAuth = await tryCompose({
      listener: { host: '0.0.0.0', port: 0, containerNamespace: true },
      authenticators: [],
    });

    for (const failure of [unmarked, noAuth]) {
      expect(failure).toBeInstanceOf(AppError);
      expect((failure as AppError).code).toBe('GATE_BLOCKED');
    }
    expect(await readdir(data)).toEqual([]);
  });

  it('M0-59 AC-9 refuses a public origin outside loopback before it opens anything', async () => {
    const data = await dir();

    const failure = await startForTest(
      ['--mode=local', '--port=0'],
      undefined,
      {
        env: {
          APP_RUNTIME: 'container',
          APP_DATA_DIR: data,
          APP_PUBLIC_ORIGIN: 'https://portal.example.com',
        },
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ModeRefusedError);
    expect(await readdir(data)).toEqual([]);
  });

  it('M0-59 AC-10 prints the banner and then the launch URL to the console, and neither reaches the logger', async () => {
    const running = await startContainer(
      ['--public-origin=http://127.0.0.1:9000'],
      { APP_KEK_PATH: join(await dir(), 'kek') },
    );

    const lines = running.consoleText.join('').trimEnd().split('\n');
    const url = lines.at(-1) ?? '';
    const banner = lines.slice(0, -1).join('\n');

    expect(banner).toContain(
      `docker run -p 127.0.0.1:9000:${String(portOf(running))}`,
    );
    expect(banner).toContain('--network host');
    expect(url).toBe(`http://127.0.0.1:9000/#t=${running.token ?? ''}`);
    expect(banner).not.toContain(running.token ?? '?');
    const logs = running.lines.join('\n');
    expect(logs).not.toContain(running.token ?? '?');
    expect(logs).not.toContain('docker run');
  });

  it('M0-59 AC-14 neither a made token nor a given one is in the diagnostics secret list of the log, the banner is the only place', async () => {
    const running = await startContainer([], { APP_TOKEN: TOKEN });

    const everything = [
      ...running.lines,
      ...running.consoleText.slice(0, -1),
    ].join('\n');

    expect(everything).not.toContain(TOKEN);
    expect(running.consoleText.join('')).toContain(`#t=${TOKEN}`);
  });
});
