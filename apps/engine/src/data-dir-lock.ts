// The data-directory lock (blueprint 1.1, step 5): one engine per data directory. Desktop and local
// mode run with `interrupt-all-running` job recovery and a single SQLite file, both of which are
// only correct when no second engine is using the directory.
//
// The lock is a file, `engine.lock`, holding `{pid, nonce}`. It is created whole and in one atomic
// step (written to a private temporary name, then hard-linked into place, which fails if the lock
// exists), so a second engine never reads a half-written lock. A lock whose process no longer exists
// is stale (the engine crashed) and is taken over; one whose process is alive, or whose content
// cannot be read, is a refusal: the lock fails closed rather than trust a guess.
//
// Honest limits (OQ-350): two engines that both find the same stale lock in the same instant can
// race on the takeover (the window is the time between a read and a rename); a process id the
// operating system has reused makes a dead engine's lock look alive until it is removed by hand;
// and a data directory on a file system without hard links cannot be locked, so it is refused.
import { randomBytes } from 'node:crypto';
import {
  link,
  mkdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

export const LOCK_FILE = 'engine.lock';

/** The data directory is in use by another engine, or its lock cannot be told apart from one. */
export class DataDirLockedError extends Error {
  readonly code = 'DATA_DIR_LOCKED';
  constructor(
    message: string,
    /** The process that holds the lock, when it could be read. */
    readonly holderPid?: number,
  ) {
    super(message);
    this.name = 'DataDirLockedError';
  }
}

export interface DataDirLock {
  readonly path: string;
  /** Removes the lock if it is still ours. Safe to call twice. */
  release(): Promise<void>;
}

export interface DataDirLockOptions {
  /** The process id to record. Default `process.pid`. */
  readonly pid?: number;
  /** Is this process alive? Default: signal 0. */
  readonly isAlive?: (pid: number) => boolean;
}

interface LockContent {
  readonly pid: number;
  readonly nonce: string;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists and belongs to someone else. Anything else (ESRCH): it is gone.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseLock(text: string): LockContent | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return undefined;
    const { pid, nonce } = value as Record<string, unknown>;
    return typeof pid === 'number' &&
      Number.isInteger(pid) &&
      pid > 0 &&
      typeof nonce === 'string'
      ? { pid, nonce }
      : undefined;
  } catch {
    return undefined;
  }
}

async function readLock(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function acquireDataDirLock(
  dataDir: string,
  options: DataDirLockOptions = {},
): Promise<DataDirLock> {
  const isAlive = options.isAlive ?? processIsAlive;
  const pid = options.pid ?? process.pid;
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, LOCK_FILE);
  const nonce = randomBytes(16).toString('hex');
  const mine = JSON.stringify({ pid, nonce } satisfies LockContent);

  /** Creates the lock whole; false when one exists. */
  async function create(): Promise<boolean> {
    const temp = `${path}.${nonce}.tmp`;
    await writeFile(temp, mine, { flag: 'wx', mode: 0o600 });
    try {
      await link(temp, path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        throw new DataDirLockedError(
          'The data directory cannot be locked: its file system refuses hard links.',
        );
      }
      throw error;
    } finally {
      await rm(temp, { force: true });
    }
  }

  // Two rounds: the second follows one takeover of a stale lock.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await create()) {
      let released = false;
      return {
        path,
        async release() {
          if (released) return;
          released = true;
          // Only our own lock: a lock another engine took over after ours was judged stale stays.
          if ((await readLock(path)) === mine) await unlink(path);
        },
      };
    }
    const text = await readLock(path);
    if (text === undefined) continue; // released between our attempt and our read: try again
    const held = parseLock(text);
    if (held === undefined) {
      throw new DataDirLockedError(
        `The lock file ${LOCK_FILE} in the data directory cannot be read; remove it if no engine is running.`,
      );
    }
    if (isAlive(held.pid)) {
      throw new DataDirLockedError(
        `Another engine (process ${String(held.pid)}) is using this data directory.`,
        held.pid,
      );
    }
    // Stale: its engine is gone. Move it aside only if it is still the lock we judged.
    if ((await readLock(path)) === text) {
      await rename(path, `${path}.stale.${nonce}`).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      await rm(`${path}.stale.${nonce}`, { force: true });
    }
  }
  throw new DataDirLockedError(
    'The data directory lock keeps changing hands; try again.',
  );
}
