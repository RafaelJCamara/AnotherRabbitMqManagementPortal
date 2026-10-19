// The three mode files, started the way the bundle starts them.
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { ActionId } from '@app/contracts';
import { createLogger } from '@app/kernel';
import type { Principal } from '@app/ports';
import { INTERNAL_HOST } from '@app/transport';
import { afterEach, describe, expect, it } from 'vitest';

import { UsageError } from '../entry/args.ts';
import {
  createFakeCtl,
  localArgs,
  randomKey,
  startForTest,
  tempDir,
  type RunningEngine,
  type TempDir,
} from '../testing/harness.ts';
import { createDesktopMode } from './desktop.ts';
import { createLocalMode } from './local.ts';
import { ModeRefusedError } from './types.ts';

const made: TempDir[] = [];
const open: RunningEngine[] = [];
async function dir(): Promise<string> {
  const temp = await tempDir('engine-mode-');
  made.push(temp);
  return temp.dir;
}
afterEach(async () => {
  for (const running of open.splice(0)) await running.engine.close();
  for (const temp of made.splice(0)) await temp.cleanup();
});

const initFrame = (data: string, dek?: Uint8Array) => ({
  t: 'init',
  paths: { data, logs: join(data, 'logs') },
  ...(dek === undefined ? {} : { dek }),
  settings: {},
});

async function startDesktop(data: string, dek?: Uint8Array) {
  const ctl = createFakeCtl();
  ctl.send(initFrame(data, dek));
  const running = await startForTest(['--mode=desktop'], ctl.port);
  open.push(running);
  return { running, ctl };
}

describe('desktop mode', () => {
  it('AC-1 boots from ctl:init, has no TCP listener, and posts ready with the contract and the schema hash', async () => {
    const data = await dir();

    const { running, ctl } = await startDesktop(data, randomKey());

    expect(running.engine.mode).toBe('desktop');
    expect(running.engine.address).toBeUndefined();
    expect(running.engine.steps).toEqual([
      'lock',
      'migrate',
      'vault',
      'trust-store',
      'reconcile',
      'ready',
    ]);
    expect(ctl.posted).toEqual([
      {
        t: 'ready',
        contract: running.engine.ready.contract,
        schemaHash: running.engine.ready.schemaHash,
      },
    ]);
    expect(existsSync(join(data, 'engine.db'))).toBe(true);
    // No console line: there is no launch URL and no token on this path.
    expect(running.consoleText).toEqual([]);
  });

  it('answers the health check in process, with the tunnel Host, and nothing else without credentials', async () => {
    const { running } = await startDesktop(await dir(), randomKey());

    const health = await running.engine.app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { host: INTERNAL_HOST },
    });
    const anonymous = await running.engine.app.inject({
      method: 'GET',
      url: '/api/v1/meta',
      headers: { host: INTERNAL_HOST },
    });
    const guessed = await running.engine.app.inject({
      method: 'GET',
      url: '/api/v1/meta',
      headers: {
        host: INTERNAL_HOST,
        'x-app-carrier': 'A'.repeat(43),
        authorization: `Bearer ${'A'.repeat(43)}`,
      },
    });

    expect(health.statusCode).toBe(200);
    expect(anonymous.statusCode).toBe(401);
    expect(guessed.statusCode).toBe(401);
  });

  it('unlocks the vault with the delivered key, zeroes the buffer main sent, and opens again with the same key', async () => {
    const data = await dir();
    const key = randomKey();
    const same = new Uint8Array(key);
    const ctl = createFakeCtl();
    const frame = initFrame(data, key);
    ctl.send(frame);

    const first = await startForTest(['--mode=desktop'], ctl.port);
    const state = first.engine.vault().state;
    await first.engine.close();
    const { running: second } = await startDesktop(data, same);

    expect(state).toBe('unlocked');
    expect(key.every((byte) => byte === 0)).toBe(true);
    expect(second.engine.vault().state).toBe('unlocked');
  });

  it('refuses a different key over a stored one: the engine does not start and the lock is released', async () => {
    const data = await dir();
    const { running } = await startDesktop(data, randomKey());
    await running.engine.close();
    const ctl = createFakeCtl();
    ctl.send(initFrame(data, randomKey()));

    await expect(startForTest(['--mode=desktop'], ctl.port)).rejects.toThrow();

    expect(existsSync(join(data, 'engine.lock'))).toBe(false);
  });

  it('zeroes the delivered key even when the start fails before the vault is opened (data directory in use)', async () => {
    const data = await dir();
    const { running } = await startDesktop(data, randomKey());
    const key = randomKey();
    const second = createFakeCtl();
    second.send(initFrame(data, key));

    await expect(startForTest(['--mode=desktop'], second.port)).rejects.toThrow(
      /using this data directory/,
    );

    expect(key.every((byte) => byte === 0)).toBe(true);
    expect(running.engine.mode).toBe('desktop');
  });

  it('starts locked when main delivers no key', async () => {
    const { running } = await startDesktop(await dir());

    expect(running.engine.vault().state).toBe('locked');
  });

  it('needs a control channel: without the desktop main process it refuses to start', async () => {
    await expect(startForTest(['--mode=desktop'])).rejects.toBeInstanceOf(
      UsageError,
    );
  });
});

describe('local mode', () => {
  it('needs --data-dir', async () => {
    await expect(
      startForTest(['--mode=local', '--port=0']),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it('binds loopback only, whatever the flags say', async () => {
    const running = await startForTest(localArgs(await dir()));
    open.push(running);

    expect(running.engine.address?.host).toBe('127.0.0.1');
    expect(running.base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('answers on the port it was given', async () => {
    const free = await startForTest(localArgs(await dir()));
    const port = free.engine.address?.port ?? 0;
    await free.engine.close();

    const running = await startForTest([
      '--mode=local',
      `--port=${String(port)}`,
      `--data-dir=${await dir()}`,
    ]);
    open.push(running);

    expect(running.engine.address?.port).toBe(port);
  });
});

describe('authorisation of the single-user modes (A-11)', () => {
  const ui: Principal = {
    kind: 'local-token',
    id: 'local-token',
    display: 'Local session',
    roles: [],
    surface: 'ui',
    unattended: false,
  };
  const delegate: Principal = {
    kind: 'mcp-client',
    id: 'agent',
    display: 'Agent',
    roles: ['*.*'],
    surface: 'mcp',
    unattended: false,
    onBehalfOf: ui,
  };
  const request = (principal: Principal, mode: 'local' | 'desktop') => ({
    principal,
    permission: 'meta.read' as const,
    actionId: 'meta.get' as ActionId,
    target: {},
    mode,
    env: 'dev' as const,
  });

  it('local: the UI principal may do and subscribe to anything, a delegate or an API token nothing', async () => {
    const { profile } = await createLocalMode({
      args: { mode: 'local', dataDir: await dir(), port: 0 },
      ctl: undefined,
      bundleDir: '',
      logger: createLogger({ level: 'silent' }),
    });

    expect(await profile.authorizer.authorize(request(ui, 'local'))).toEqual({
      allowed: true,
    });
    expect(
      (await profile.authorizer.authorize(request(delegate, 'local'))).allowed,
    ).toBe(false);
    expect(profile.canSubscribe(ui, 'meta.read')).toBe(true);
    expect(profile.canSubscribe(delegate, 'meta.read')).toBe(false);
  });

  it('desktop: the same policy', async () => {
    const ctl = createFakeCtl();
    ctl.send(initFrame(await dir()));
    const { profile } = await createDesktopMode({
      args: { mode: 'desktop' },
      ctl: ctl.port,
      bundleDir: '',
      logger: createLogger({ level: 'silent' }),
    });
    const desktopUi: Principal = {
      ...ui,
      kind: 'desktop-user',
      id: 'desktop-user',
    };

    expect(
      await profile.authorizer.authorize(request(desktopUi, 'desktop')),
    ).toEqual({ allowed: true });
    expect(
      (await profile.authorizer.authorize(request(delegate, 'desktop')))
        .allowed,
    ).toBe(false);
    expect(profile.canSubscribe(desktopUi, 'meta.read')).toBe(true);
    expect(profile.canSubscribe(delegate, 'meta.read')).toBe(false);
    expect(profile.listener).toBeUndefined();
    expect(profile.jobs).toEqual({
      recovery: 'interrupt-all-running',
      autoResume: 'never',
    });
  });

  it('local: jobs that a crash left running are all interrupted and none resumes by itself (OQ-316 maps it)', async () => {
    const { profile } = await createLocalMode({
      args: { mode: 'local', dataDir: await dir(), port: 0 },
      ctl: undefined,
      bundleDir: '',
      logger: createLogger({ level: 'silent' }),
    });

    expect(profile.jobs).toEqual({
      recovery: 'interrupt-all-running',
      autoResume: 'never',
    });
    expect(profile.storage.lockDir).toBeDefined();
  });
});

describe('team mode', () => {
  it('AC-1 refuses to start until M3, before it takes a lock, opens a file or binds a socket', async () => {
    const data = await dir();

    await expect(
      startForTest(['--mode=team', `--data-dir=${data}`, '--port=0']),
    ).rejects.toBeInstanceOf(ModeRefusedError);

    expect(await readdir(data)).toEqual([]);
  });
});
