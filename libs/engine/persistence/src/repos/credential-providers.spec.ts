import { credentialProvidersContract } from '../testing/credential-providers-contract';
import { openMigratedSqlite } from '../testing/sqlite-fixtures';

// The same contract runs on Postgres 16 and 18 in src/it/persistence.it.ts.
credentialProvidersContract({
  name: 'sqlite (in memory)',
  open: () => openMigratedSqlite(),
});
