// Helpers for tests that need a real SQLite database. Test-only.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PersistenceHandle } from '../database';
import { openSqlite } from '../dialects/node-sqlite';
import { createMigrationRunner } from '../migrate/runner';

/** A temporary directory removed by the returned `dispose`. */
export async function tempDirectory(): Promise<{
  dir: string;
  dispose: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'persistence-'));
  return {
    dir,
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

/** A SQLite database with every engine migration applied. */
export async function openMigratedSqlite(
  path = ':memory:',
): Promise<PersistenceHandle> {
  const handle = await openSqlite({ path });
  await createMigrationRunner({ handle }).migrate();
  return handle;
}
