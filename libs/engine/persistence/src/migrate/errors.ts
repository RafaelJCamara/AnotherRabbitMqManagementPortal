import { randomUUID } from 'node:crypto';

import type { Problem } from '@app/contracts';

/** `urn:problem:schema-too-new`. A dedicated error code is OQ-160; until then the code is INTERNAL. */
export const SCHEMA_TOO_NEW_TYPE = 'urn:problem:schema-too-new';

/**
 * The database was written by a newer engine (ADR-013, A-18: no downgrade across schemas). The
 * engine refuses to start. `problem` is the Problem the entry point reports; this library cannot
 * use the kernel's `AppError` (an adapter never imports the kernel), so it carries the plain
 * contract object.
 */
export class SchemaTooNewError extends Error {
  readonly found: number;
  readonly supported: number;
  readonly problem: Problem;

  constructor(found: number, supported: number, correlationId?: string) {
    const detail = `The database is at schema version ${String(found)} but this engine supports up to ${String(supported)}. Start a newer engine, or restore a backup taken before the upgrade.`;
    super(detail);
    this.name = 'SchemaTooNewError';
    this.found = found;
    this.supported = supported;
    this.problem = {
      type: SCHEMA_TOO_NEW_TYPE,
      title: 'Database schema is newer than this engine',
      status: 500,
      code: 'INTERNAL',
      detail,
      correlationId: correlationId ?? randomUUID(),
      retryable: false,
    };
  }
}

/** The applied migrations are not a prefix of this engine's migrations: the history diverged. */
export class MigrationHistoryError extends Error {
  constructor(applied: string, expected: string | undefined) {
    super(
      `The database applied migration ${applied} where this engine expects ${expected ?? 'nothing more'}. Restore a backup or use the engine that wrote the database.`,
    );
    this.name = 'MigrationHistoryError';
  }
}
