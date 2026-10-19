import { jobStoreContract } from '@app/ports/testing';
import { afterAll } from 'vitest';

import type { PersistenceHandle } from '../database';
import { openMigratedSqlite } from '../testing/sqlite-fixtures';
import { repositoryContract } from '../testing/repository-contract';
import { createRepositories } from '.';

// The same contracts run on Postgres in src/it/persistence.it.ts.
repositoryContract({
  name: 'AC-1 sqlite (in memory)',
  open: () => openMigratedSqlite(),
});

const opened: PersistenceHandle[] = [];
afterAll(async () => {
  await Promise.all(opened.map((handle) => handle.close()));
});

jobStoreContract({
  name: 'sqlite (in memory)',
  open: async () => {
    const handle = await openMigratedSqlite();
    opened.push(handle);
    return createRepositories(handle).jobs;
  },
});
