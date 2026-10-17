import { execFile } from 'node:child_process';
import { createServer } from 'node:net';

/** Options of one docker call. `env` is added to the process environment. */
export interface DockerOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

/**
 * Runs `docker <args>` and resolves with its standard output. Tests inject a fake; the default runs
 * the docker CLI. The CLI is used directly (no npm container library), see OQ-80.
 */
export type Docker = (
  args: readonly string[],
  options?: DockerOptions,
) => Promise<string>;

/** The end of a long output (image pull progress comes first, the reason comes last). */
const lastLines = (text: string, count = 12): string =>
  text.trim().split(/\r?\n/).slice(-count).join('\n');

export const dockerCli: Docker = (args, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      'docker',
      [...args],
      {
        env: { ...process.env, ...options.env },
        timeout: options.timeoutMs ?? 600_000,
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `docker ${args.slice(0, 3).join(' ')} failed: ${lastLines(stderr) || error.message}`,
            ),
          );
        } else {
          resolve(stdout);
        }
      },
    );
  });

/** Asks the OS for a free TCP port on the loopback interface. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address !== null && typeof address === 'object') {
          resolve(address.port);
        } else {
          reject(new Error('could not read the port the OS assigned'));
        }
      });
    });
  });
}

/**
 * Reads the host port from the output of `docker port` / `docker compose port`, for example
 * `127.0.0.1:49153` (one line per binding; the first one wins).
 */
export function parseHostPort(output: string): number {
  const line = output.split(/\r?\n/).find((entry) => entry.trim() !== '');
  const match = line ? /:(\d+)\s*$/.exec(line.trim()) : null;
  if (!match?.[1]) {
    throw new Error(`cannot read a host port from ${JSON.stringify(output)}`);
  }
  return Number(match[1]);
}
