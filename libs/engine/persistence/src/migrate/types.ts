import type { ColumnTypes, DialectName } from './helpers';

/** The statement runner a migration receives; the runner implements it over one transaction. */
export interface SqlExecutor {
  readonly dialect: DialectName;
  /** Dialect helpers: `db.t.id()`, `db.t.json()`, `db.t.epochMs()`, `db.t.bytes()`. */
  readonly t: ColumnTypes;
  execute(sql: string): Promise<void>;
}

export interface Migration {
  /** `NNNN_name`, equal to the file name without the extension. */
  readonly id: string;
  up(db: SqlExecutor): Promise<void>;
}
