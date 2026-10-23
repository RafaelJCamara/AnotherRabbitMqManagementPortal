// The whole capture stack on one machine (M1-09): a real SQLite file with every migration, the real
// repository, the real field cipher (AES-256-GCM over a key ring that can rotate) and the real
// capture store of svc-messages. Used by the testkit's own specs, by `perf:capture-ingest` and by
// any spec that must see what a database file holds. Test support only: nothing here ships.
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createIdGenerator } from '@app/kernel';
import {
  createMigrationRunner,
  createRepositories,
  executeRawStatement,
  openSqlite,
  type PersistenceHandle,
} from '@app/persistence';
import type { CaptureRepository } from '@app/ports';
import { createFieldCipher, type KeyRing } from '@app/secrets';
import {
  createCaptureStore,
  type CaptureStore,
  type CaptureStoreOptions,
} from '@app/svc-messages';

export interface RotatingKeyRing extends KeyRing {
  /** Makes a new key the current one; the older keys still open what they sealed. */
  rotate(): string;
  /** Forgets a key: what it sealed no longer opens. */
  forget(id: string): void;
  readonly ids: () => readonly string[];
}

/** A key ring with the shape the vault gives the field cipher, holding random keys in memory. */
export function createRotatingKeyRing(): RotatingKeyRing {
  const keys = new Map<string, Uint8Array>();
  let current = '';
  const rotate = (): string => {
    current = randomBytes(16).toString('hex');
    keys.set(current, new Uint8Array(randomBytes(32)));
    return current;
  };
  rotate();
  return {
    current: () => ({
      id: current,
      key: keys.get(current) ?? new Uint8Array(),
    }),
    byId: (id) => keys.get(id),
    rotate,
    forget: (id) => {
      keys.delete(id);
    },
    ids: () => [...keys.keys()],
  };
}

export interface CaptureStack {
  readonly dir: string;
  readonly path: string;
  readonly handle: PersistenceHandle;
  readonly repo: CaptureRepository;
  readonly keys: RotatingKeyRing;
  readonly store: CaptureStore;
  /** Everything the database file and its write-ahead log hold, as bytes. */
  fileBytes(): Promise<Buffer>;
  /** Folds the write-ahead log into the file, so the file holds everything. */
  checkpoint(): Promise<void>;
  close(): Promise<void>;
}

export interface CaptureStackOptions {
  /**
   * The repository the store writes through. Defaults to the repository over the stack's own
   * connection; the engine's smoke spec passes a client of the real capture worker thread, which
   * opens a second connection to the same file.
   */
  readonly repository?: (info: {
    handle: PersistenceHandle;
    path: string;
  }) => Promise<CaptureRepository> | CaptureRepository;
  readonly options?: Partial<CaptureStoreOptions>;
  readonly now?: () => number;
  readonly logger?: Parameters<typeof createCaptureStore>[0]['logger'];
}

export async function createCaptureStack(
  stack: CaptureStackOptions = {},
): Promise<CaptureStack> {
  const dir = await mkdtemp(join(tmpdir(), 'capture-stack-'));
  const path = join(dir, 'data.db');
  const handle = await openSqlite({ path });
  await createMigrationRunner({ handle }).migrate();
  const repo =
    (await stack.repository?.({ handle, path })) ??
    createRepositories(handle).captures;
  const keys = createRotatingKeyRing();
  const ids = createIdGenerator();
  const store = createCaptureStore({
    repo,
    sealer: createFieldCipher(keys),
    newId: () => ids.ulid(),
    ...(stack.now === undefined ? {} : { now: stack.now }),
    ...(stack.logger === undefined ? {} : { logger: stack.logger }),
    ...(stack.options === undefined ? {} : { options: stack.options }),
  });
  let closed = false;
  return {
    dir,
    path,
    handle,
    repo,
    keys,
    store,
    async fileBytes() {
      const parts = await Promise.all(
        [path, `${path}-wal`].map((file) =>
          readFile(file).catch(() => Buffer.alloc(0)),
        ),
      );
      return Buffer.concat(parts);
    },
    async checkpoint() {
      await executeRawStatement(handle, 'PRAGMA wal_checkpoint(TRUNCATE)');
    },
    async close() {
      if (closed) return;
      closed = true;
      await store.close();
      await handle.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
