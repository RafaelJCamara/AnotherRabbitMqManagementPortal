import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('persistence public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'CaptureWorkerError',
      'MigrationHistoryError',
      'SCHEMA_TOO_NEW_TYPE',
      'SchemaTooNewError',
      'columnTypes',
      'createCaptureRepositoryClient',
      'createMigrationRunner',
      'createRepositories',
      'executeRawStatement',
      'migrations',
      'openPg',
      'openSqlite',
      'serveCaptureRepository',
    ]);
  });
});
