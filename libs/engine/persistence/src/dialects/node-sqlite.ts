// The in-repo Kysely dialect over node:sqlite (ADR-013): no native addon on desktop or npx.
// Kysely's own SQLite dialect expects better-sqlite3, so this file is the driver (one connection,
// serialised by a mutex), reusing Kysely's SQLite adapter, compiler and introspector.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import {
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
} from 'kysely';

import type { Database, PersistenceHandle } from '../database';

export interface NodeSqliteOptions {
  /** The database file, or `:memory:`. */
  path: string;
  /** `PRAGMA busy_timeout`, in ms. Blueprint 6.1: 5000. */
  busyTimeoutMs?: number;
  /** Return INTEGER columns as bigint. Off by default: repositories expect numbers. */
  readBigInts?: boolean;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/** Serialises use of the single connection, so two transactions never interleave. */
class ConnectionMutex {
  #tail: Promise<void> = Promise.resolve();

  /** Resolves with the release function once every earlier holder has released. */
  lock(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = this.#tail.then(() => release);
    this.#tail = this.#tail.then(() => held);
    return acquired;
  }
}

/** node:sqlite binds null, number, bigint, string and bytes. Booleans become 0 and 1. */
function bind(value: unknown): SQLInputValue {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError(
    `Cannot bind a ${value === undefined ? 'undefined' : typeof value} value to a SQLite statement; use null, number, bigint, string or bytes.`,
  );
}

class NodeSqliteConnection implements DatabaseConnection {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const { sql, parameters } = compiledQuery;
    return new Promise((resolve, reject) => {
      try {
        const statement = this.#db.prepare(sql);
        const params = parameters.map(bind);
        // A statement that yields columns is a reader (SELECT, RETURNING, PRAGMA queries).
        if (statement.columns().length > 0) {
          resolve({ rows: statement.all(...params) as R[] });
          return;
        }
        const { changes, lastInsertRowid } = statement.run(...params);
        resolve({
          insertId: BigInt(lastInsertRowid),
          numAffectedRows: BigInt(changes),
          rows: [],
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error(
      'The node:sqlite dialect does not stream; page with a keyset (I-7).',
    );
  }
}

class NodeSqliteDriver implements Driver {
  readonly #options: NodeSqliteOptions;
  readonly #mutex = new ConnectionMutex();
  #db: DatabaseSync | undefined;
  #connection: NodeSqliteConnection | undefined;
  #release: (() => void) | undefined;

  constructor(options: NodeSqliteOptions) {
    this.#options = options;
  }

  init(): Promise<void> {
    const { path, busyTimeoutMs, readBigInts } = this.#options;
    const db = new DatabaseSync(path, { readBigInts: readBigInts ?? false });
    const timeout = Math.trunc(busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);
    db.exec(`PRAGMA busy_timeout = ${String(timeout)}`);
    db.exec('PRAGMA foreign_keys = ON');
    // WAL keeps readers and the one writer out of each other's way. It is a no-op for :memory:.
    db.exec('PRAGMA journal_mode = WAL');
    this.#db = db;
    this.#connection = new NodeSqliteConnection(db);
    return Promise.resolve();
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    this.#release = await this.#mutex.lock();
    if (this.#connection === undefined) {
      this.#release();
      throw new Error('The node:sqlite driver is not initialised.');
    }
    return this.#connection;
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('begin'));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('commit'));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('rollback'));
  }

  releaseConnection(): Promise<void> {
    const release = this.#release;
    this.#release = undefined;
    release?.();
    return Promise.resolve();
  }

  destroy(): Promise<void> {
    this.#db?.close();
    this.#db = undefined;
    this.#connection = undefined;
    return Promise.resolve();
  }
}

/** A Kysely dialect over node:sqlite. */
export function createNodeSqliteDialect(options: NodeSqliteOptions): Dialect {
  return {
    createDriver: () => new NodeSqliteDriver(options),
    createQueryCompiler: () => new SqliteQueryCompiler(),
    createAdapter: () => new SqliteAdapter(),
    createIntrospector: (db) => new SqliteIntrospector(db),
  };
}

/** Opens (creating when absent) a SQLite database and returns its handle. */
export async function openSqlite(
  options: NodeSqliteOptions,
): Promise<PersistenceHandle> {
  const db = new Kysely<Database>({
    dialect: createNodeSqliteDialect(options),
  });
  // Kysely initialises the driver on first use; do it now so a bad path fails here.
  await db.connection().execute(() => Promise.resolve());
  return {
    dialect: 'sqlite',
    db,
    path: options.path === ':memory:' ? undefined : options.path,
    close: () => db.destroy(),
  };
}
