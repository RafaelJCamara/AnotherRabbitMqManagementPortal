import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acquireDataDirLock,
  DataDirLockedError,
  LOCK_FILE,
} from './data-dir-lock.ts';
import { tempDir, type TempDir } from './testing/harness.ts';

const made: TempDir[] = [];
async function dir(): Promise<string> {
  const temp = await tempDir('engine-lock-');
  made.push(temp);
  return temp.dir;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const temp of made.splice(0)) await temp.cleanup();
});

const staleLock = (pid: number) => JSON.stringify({ pid, nonce: 'old' });

describe('data-directory lock', () => {
  it('AC-1 a second engine on the same directory is refused, naming the process that holds it', async () => {
    const path = await dir();
    const first = await acquireDataDirLock(path);

    const failure = await acquireDataDirLock(path).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(DataDirLockedError);
    expect((failure as DataDirLockedError).holderPid).toBe(process.pid);
    expect((failure as DataDirLockedError).code).toBe('DATA_DIR_LOCKED');
    await first.release();
  });

  it('creates the lock whole, with no temporary file left behind, and removes it on release', async () => {
    const path = await dir();

    const lock = await acquireDataDirLock(path, { pid: 4242 });

    expect(await readdir(path)).toEqual([LOCK_FILE]);
    expect(JSON.parse(await readFile(lock.path, 'utf8'))).toMatchObject({
      pid: 4242,
    });
    await lock.release();
    await lock.release(); // twice is fine
    expect(existsSync(lock.path)).toBe(false);
  });

  it('two releases at once remove the lock once and neither fails', async () => {
    const path = await dir();
    const lock = await acquireDataDirLock(path);

    await expect(
      Promise.all([lock.release(), lock.release()]),
    ).resolves.toBeDefined();

    expect(existsSync(lock.path)).toBe(false);
  });

  it('release leaves a lock that is no longer ours (another engine took over)', async () => {
    const path = await dir();
    const lock = await acquireDataDirLock(path);
    await writeFile(lock.path, staleLock(process.pid));

    await lock.release();

    expect(existsSync(lock.path)).toBe(true);
  });

  it('takes over the lock of an engine that no longer exists, leaving nothing of the old one', async () => {
    const path = await dir();
    await writeFile(join(path, LOCK_FILE), staleLock(999_999));

    const lock = await acquireDataDirLock(path, {
      pid: 7,
      isAlive: (pid) => pid !== 999_999,
    });

    expect(JSON.parse(await readFile(lock.path, 'utf8'))).toMatchObject({
      pid: 7,
    });
    expect(await readdir(path)).toEqual([LOCK_FILE]);
  });

  it('does not move aside a lock that another engine took over while it was judging the old one', async () => {
    const path = await dir();
    await writeFile(join(path, LOCK_FILE), staleLock(999_999));
    // Between our read of the stale lock and our move of it, a live engine takes the lock.
    const isAlive = (pid: number): boolean => {
      if (pid !== 999_999) return true;
      writeFileSync(
        join(path, LOCK_FILE),
        JSON.stringify({ pid: 555, nonce: 'live' }),
      );
      return false;
    };

    const failure = await acquireDataDirLock(path, { isAlive }).catch(
      (e: unknown) => e,
    );

    expect(failure).toBeInstanceOf(DataDirLockedError);
    expect((failure as DataDirLockedError).holderPid).toBe(555);
    expect(
      JSON.parse(await readFile(join(path, LOCK_FILE), 'utf8')),
    ).toMatchObject({
      pid: 555,
    });
  });

  it('takes over a lock whose process really is gone (default liveness check)', async () => {
    const path = await dir();
    const child = spawnSync(process.execPath, ['-e', '0']);
    expect(child.pid).toBeGreaterThan(0);
    await writeFile(join(path, LOCK_FILE), staleLock(child.pid));

    const lock = await acquireDataDirLock(path);

    expect(JSON.parse(await readFile(lock.path, 'utf8'))).toMatchObject({
      pid: process.pid,
    });
  });

  it('refuses a lock whose process is alive, even when the signal is not permitted (EPERM)', async () => {
    const path = await dir();
    await writeFile(join(path, LOCK_FILE), staleLock(999_999));
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    });

    await expect(acquireDataDirLock(path)).rejects.toBeInstanceOf(
      DataDirLockedError,
    );
    expect(await readFile(join(path, LOCK_FILE), 'utf8')).toBe(
      staleLock(999_999),
    );
  });

  it('refuses a lock it cannot read rather than guess that it is stale', async () => {
    const path = await dir();
    for (const content of [
      '',
      'not json',
      '{"pid":"7","nonce":"n"}',
      '{"pid":0,"nonce":"n"}',
      '[]',
      'null',
    ]) {
      await writeFile(join(path, LOCK_FILE), content);

      await expect(
        acquireDataDirLock(path, { isAlive: () => false }),
      ).rejects.toBeInstanceOf(DataDirLockedError);

      expect(await readFile(join(path, LOCK_FILE), 'utf8')).toBe(content);
    }
  });

  it('creates the data directory when it does not exist yet', async () => {
    const path = join(await dir(), 'nested', 'data');

    const lock = await acquireDataDirLock(path);

    expect(existsSync(lock.path)).toBe(true);
  });
});
