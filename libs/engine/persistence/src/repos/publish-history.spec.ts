import { publishHistoryContract } from '../testing/publish-history-contract';
import { openMigratedSqlite } from '../testing/sqlite-fixtures';

// The same contract runs on Postgres 16 and 18 in src/it/persistence.it.ts.
publishHistoryContract({
  name: 'sqlite (in memory)',
  open: () => openMigratedSqlite(),
});
