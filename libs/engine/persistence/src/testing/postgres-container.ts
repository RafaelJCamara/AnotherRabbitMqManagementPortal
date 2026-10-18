// A throwaway Postgres in a Docker container for the integration tests. It drives the `docker`
// CLI, as libs/testkit does for the broker lab, so no extra dependency is needed (OQ-161).
// Test-only; excluded from the library build.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import pg from 'pg';

const run = promisify(execFile);

const USER = 'app';
const PASSWORD = 'persistence-it';
const READY_TIMEOUT_MS = 90_000;

async function docker(...args: string[]): Promise<string> {
  try {
    const { stdout } = await run('docker', args, { encoding: 'utf8' });
    return stdout.trim();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `docker ${args.slice(0, 2).join(' ')} failed (is a Docker daemon running?): ${reason}`,
      { cause: error },
    );
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface PostgresContainer {
  /** The Postgres major version, for example `16`. */
  readonly version: string;
  /** Connection string of the server's `postgres` database. */
  readonly adminUrl: string;
  /** Connection string of a new, empty database on this server. */
  createDatabase(): Promise<string>;
  stop(): Promise<void>;
}

/** Starts `postgres:<version>` on a random local port and waits until it accepts TCP connections. */
export async function startPostgres(
  version: string,
): Promise<PostgresContainer> {
  if (!/^\d+$/.test(version)) {
    throw new Error(
      `Postgres version must be a major number, got "${version}".`,
    );
  }
  const id = await docker(
    'run',
    '--detach',
    '--rm',
    '--label',
    'io.persistence-it=1',
    '--publish',
    '127.0.0.1::5432',
    '--env',
    `POSTGRES_USER=${USER}`,
    '--env',
    `POSTGRES_PASSWORD=${PASSWORD}`,
    '--env',
    'POSTGRES_DB=postgres',
    `postgres:${version}`,
  );
  const stop = async () => {
    await docker('rm', '--force', id);
  };

  try {
    const mapping = (await docker('port', id, '5432/tcp')).split('\n')[0] ?? '';
    const port = /:(\d+)$/.exec(mapping)?.[1];
    if (port === undefined)
      throw new Error(`No port mapping for ${id}: "${mapping}".`);

    // The image first runs a socket-only bootstrap server; only the final one listens on TCP.
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      try {
        await docker(
          'exec',
          id,
          'pg_isready',
          '--host',
          '127.0.0.1',
          '--username',
          USER,
        );
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await sleep(500);
      }
    }

    const urlFor = (database: string) =>
      `postgres://${USER}:${PASSWORD}@127.0.0.1:${port}/${database}`;
    let counter = 0;
    return {
      version,
      adminUrl: urlFor('postgres'),
      async createDatabase() {
        counter += 1;
        const name = `it_${String(counter)}`;
        const client = new pg.Client({ connectionString: urlFor('postgres') });
        await client.connect();
        try {
          await client.query(`CREATE DATABASE ${name}`);
        } finally {
          await client.end();
        }
        return urlFor(name);
      },
      stop,
    };
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
}
