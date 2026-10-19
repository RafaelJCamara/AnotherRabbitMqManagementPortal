// What each drain phase does in the composed engine (blueprint 1.1): live clients are told to go,
// the executor stops taking work, queued audit rows are written, the database is closed on quit and
// left open on suspend.
import { join } from 'node:path';

import { createLogger } from '@app/kernel';
import {
  createRepositories,
  openSqlite,
  type PersistenceHandle,
  type Repositories,
} from '@app/persistence';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  composeEngine,
  type Engine,
  type ModeProfile,
} from './compose-core.ts';
import { createLocalMode } from './modes/local.ts';
import { coreModules } from './modules/index.ts';
import { tempDir, type TempDir } from './testing/harness.ts';

const log = createLogger({ level: 'silent' });
const made: TempDir[] = [];
const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  for (const temp of made.splice(0)) await temp.cleanup();
});

interface Booted {
  readonly engine: Engine;
  readonly dir: string;
  readonly token: string;
  readonly base: string;
  readonly handle: () => PersistenceHandle;
}

async function boot(
  decorate?: (repositories: Repositories) => Repositories,
): Promise<Booted> {
  const temp = await tempDir('engine-drain-');
  made.push(temp);
  const boot = await createLocalMode({
    args: { mode: 'local', dataDir: temp.dir, port: 0 },
    ctl: undefined,
    bundleDir: temp.dir,
    logger: log,
  });
  let opened: PersistenceHandle | undefined;
  const profile: ModeProfile = {
    ...boot.profile,
    storage: {
      ...boot.profile.storage,
      open: async () =>
        (opened = await openSqlite({ path: join(temp.dir, 'engine.db') })),
    },
  };
  const engine = await composeEngine({
    profile,
    modules: coreModules,
    engineVersion: '0.0.0',
    logger: log,
    trust: { includeSystem: false },
    ...(decorate === undefined ? {} : { decorateRepositories: decorate }),
  });
  engines.push(engine);
  const launch = boot.launchUrl?.({
    host: '127.0.0.1',
    port: engine.address?.port ?? 0,
  });
  return {
    engine,
    dir: temp.dir,
    token: /#t=(.+)$/.exec(launch ?? '')?.[1] ?? '',
    base: `127.0.0.1:${String(engine.address?.port ?? 0)}`,
    handle: () => {
      if (opened === undefined) throw new Error('the database was not opened');
      return opened;
    },
  };
}

const arm = (booted: Booted, key: string) =>
  fetch(`http://${booted.base}/api/v1/connections/c1/arm`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${booted.token}`,
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    body: '{}',
  });

/** A live client past the handshake; `frames` fills as the engine sends. */
async function liveClient(booted: Booted) {
  const issued = await fetch(`http://${booted.base}/api/v1/live/tickets`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${booted.token}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  const { ticket } = (await issued.json()) as { ticket: string };
  const frames: Record<string, unknown>[] = [];
  const socket = new WebSocket(`ws://${booted.base}/api/v1/live`, [
    'app.v1',
    `app.ticket.${ticket}`,
  ]);
  socket.addEventListener('message', (message) => {
    frames.push(JSON.parse(String(message.data)) as Record<string, unknown>);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ t: 'hello', v: 1 }));
      resolve();
    });
    socket.addEventListener('error', () => {
      reject(new Error('the live socket did not open'));
    });
  });
  await vi.waitFor(() => {
    expect(frames.map((frame) => frame.t)).toContain('welcome');
  });
  return { frames, socket };
}

describe('drain phases', () => {
  it('the gate tells live clients to go away on quit, SIGTERM and emergency, but not on suspend', async () => {
    const quitting = await boot();
    const client = await liveClient(quitting);
    await quitting.engine.drain('sigterm', 2000);
    await vi.waitFor(() => {
      expect(client.frames.map((frame) => frame.t)).toContain('goaway');
    });

    const sleeping = await boot();
    const other = await liveClient(sleeping);
    await sleeping.engine.drain('suspend', 2000);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(other.frames.map((frame) => frame.t)).not.toContain('goaway');
    other.socket.close();
  });

  it('a suspend freezes mutations and keeps serving; it does not mark the engine as draining', async () => {
    const booted = await boot();

    await booted.engine.drain('suspend', 2000);
    const frozen = await arm(booted, 'spec-key-suspend');
    const ready = await fetch(`http://${booted.base}/readyz`);

    expect(frozen.status).toBeGreaterThanOrEqual(400);
    expect(((await frozen.json()) as { code: string }).code).toBe('FROZEN');
    expect(ready.status).toBe(200);
  });

  it('the flush phase closes the database on quit and leaves it open on suspend', async () => {
    const quitting = await boot();
    const closeOnQuit = vi.spyOn(quitting.handle(), 'close');
    const sleeping = await boot();
    const closeOnSuspend = vi.spyOn(sleeping.handle(), 'close');

    await sleeping.engine.drain('suspend', 2000);
    expect(closeOnSuspend).not.toHaveBeenCalled();
    await quitting.engine.drain('quit', 2000);
    expect(closeOnQuit).toHaveBeenCalledTimes(1);

    await quitting.engine.close();
    expect(closeOnQuit).toHaveBeenCalledTimes(1);
  });

  it('close() drains first when nobody has: queued audit rows are written', async () => {
    let failOutcomes = true;
    const booted = await boot((repositories) => ({
      ...repositories,
      audit: {
        ...repositories.audit,
        append: (row) =>
          failOutcomes && row.phase === 'outcome'
            ? Promise.reject(new Error('the audit store is down'))
            : repositories.audit.append(row),
      },
    }));
    await arm(booted, 'spec-key-close-1');
    failOutcomes = false;

    await booted.engine.close();

    const reader = await openSqlite({ path: join(booted.dir, 'engine.db') });
    try {
      const rows = await createRepositories(reader).audit.window(0, 10);
      expect(rows.map((row) => row.phase)).toEqual(['attempt', 'outcome']);
    } finally {
      await reader.close();
    }
  });

  it('the flush phase writes the audit outcome rows that could not be written while the store was failing', async () => {
    let failOutcomes = true;
    const booted = await boot((repositories) => ({
      ...repositories,
      audit: {
        ...repositories.audit,
        append: (row) =>
          failOutcomes && row.phase === 'outcome'
            ? Promise.reject(new Error('the audit store is down'))
            : repositories.audit.append(row),
      },
    }));

    const armed = await arm(booted, 'spec-key-audit-flush');
    failOutcomes = false;
    await booted.engine.drain('quit', 2000);

    expect(armed.status).toBe(200);
    const reader = await openSqlite({ path: join(booted.dir, 'engine.db') });
    try {
      const rows = await createRepositories(reader).audit.window(0, 10);
      expect(rows.map((row) => row.phase)).toEqual(['attempt', 'outcome']);
    } finally {
      await reader.close();
    }
  });
});
