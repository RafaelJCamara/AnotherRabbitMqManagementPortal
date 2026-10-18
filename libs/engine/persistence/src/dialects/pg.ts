// The Postgres dialect (ADR-013): Kysely's own PostgresDialect over a pg Pool. Team server only;
// Postgres 16 and 18 are tested. The app role is DML only in production (migrations run under a
// DDL role in a Helm hook Job), so this file never creates a role or a database.
import { Kysely, PostgresDialect } from 'kysely';
import pg, { type CustomTypesConfig } from 'pg';

import type { Database, PersistenceHandle } from '../database';

export interface PgOptions {
  connectionString: string;
  /** Pool size. Default 10. */
  maxConnections?: number;
  /** Called with errors from idle pooled clients; without a listener they would crash the process. */
  onPoolError?: (error: Error) => void;
}

/** pg returns BIGINT as a string; epoch milliseconds and counters fit a safe integer. */
function parseInt8(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`BIGINT ${value} is outside the safe integer range.`);
  }
  return parsed;
}

/** Per-pool parsers, so the process-wide pg type registry is left alone. */
const types: CustomTypesConfig = {
  getTypeParser: (id, format) => {
    if (id === pg.types.builtins.INT8) return parseInt8;
    const fallback: unknown = pg.types.getTypeParser(id, format);
    return fallback;
  },
};

/** Opens a Postgres pool and returns its handle. The first query connects. */
export function openPg(options: PgOptions): PersistenceHandle {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    types,
  });
  pool.on('error', (error) => options.onPoolError?.(error));
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return {
    dialect: 'pg',
    db,
    path: undefined,
    close: () => db.destroy(),
  };
}
