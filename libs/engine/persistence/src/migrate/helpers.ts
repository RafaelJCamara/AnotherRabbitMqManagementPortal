// Dialect helpers for the one migration set (ADR-013, blueprint 6.1). A migration writes
// `${db.t.bytes()}` where the two dialects differ, and plain SQL everywhere else, so the same file
// runs on SQLite and on Postgres.

/** The two storage dialects: desktop and local (`sqlite`), team server (`pg`). */
export type DialectName = 'sqlite' | 'pg';

/** Column types for DDL. Each method returns the type name for the dialect it was built for. */
export interface ColumnTypes {
  /** An identifier: ULID, UUID, content hash or alias. TEXT on both dialects. */
  id(): string;
  /** A JSON document, stored as TEXT on both dialects so the two stay byte-identical. */
  json(): string;
  /** Milliseconds since the epoch. BIGINT on both (SQLite stores it as a 64-bit INTEGER). */
  epochMs(): string;
  /** Raw bytes: BLOB on SQLite, BYTEA on Postgres. */
  bytes(): string;
}

/** The helpers `t.id()`, `t.json()`, `t.epochMs()` and `t.bytes()` for a dialect. */
export function columnTypes(dialect: DialectName): ColumnTypes {
  return {
    id: () => 'TEXT',
    json: () => 'TEXT',
    epochMs: () => 'BIGINT',
    bytes: () => (dialect === 'pg' ? 'BYTEA' : 'BLOB'),
  };
}
