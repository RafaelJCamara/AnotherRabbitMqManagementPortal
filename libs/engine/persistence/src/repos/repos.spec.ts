import { openMigratedSqlite } from '../testing/sqlite-fixtures';
import { repositoryContract } from '../testing/repository-contract';

// The same contract runs on Postgres in src/it/persistence.it.ts.
repositoryContract({
  name: 'AC-1 sqlite (in memory)',
  open: () => openMigratedSqlite(),
});
