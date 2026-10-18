// A short-lived local endpoint for libraries that cannot take a socket (plain-TCP amqplib and the
// stream client connect by host and port or by path). The Dialer opens the upstream connection
// first, under the egress policy, then offers it on one Unix socket (a named pipe on Windows) that
// accepts exactly one client.
//
// Threat T2 (blueprint 7.3): other local processes must not reach it.
//   - Unix: a private 0700 directory holds a 0600 socket;
//   - Windows: a pipe with a 128-bit random name (the default DACL is the OS's; see OQ-186);
//   - one connection, then the listener closes; nobody connecting in `acceptTimeoutMs` closes it.
// No TCP port is ever opened (invariant: no new listeners).
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NetworkError } from '@app/net-truststore';

export interface Forwarder {
  /** Unix socket path, or the named pipe on Windows. Connect with `net.connect({ path })`. */
  readonly path: string;
  /** Idempotent. Closes the listener and the connections and removes the socket. */
  close(): Promise<void>;
}

export interface ForwarderOptions {
  /** How long to wait for the client. Default 30 seconds. */
  readonly acceptTimeoutMs?: number;
}

const DEFAULT_ACCEPT_TIMEOUT_MS = 30_000;

/** Takes ownership of `upstream`: it is destroyed if the forwarder cannot start. */
export async function openForwarder(
  upstream: Socket,
  options: ForwarderOptions = {},
): Promise<Forwarder> {
  const windows = process.platform === 'win32';
  const directory = windows
    ? undefined
    : mkdtempSync(join(tmpdir(), 'app-fwd-'));
  const path =
    directory === undefined
      ? `\\\\.\\pipe\\app-fwd-${randomBytes(16).toString('hex')}`
      : join(directory, 'fwd.sock');

  let client: Socket | undefined;
  let closing: Promise<void> | undefined;

  const server: Server = createServer((socket) => {
    // The first connection is the client; the listener stops at once so there is no second.
    clearTimeout(acceptTimer);
    client = socket;
    server.close();
    const end = (): void => {
      socket.destroy();
      upstream.destroy();
    };
    socket.on('error', end);
    socket.on('close', end);
    upstream.on('error', end);
    upstream.on('close', end);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  server.maxConnections = 1;

  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve) => {
      clearTimeout(acceptTimer);
      client?.destroy();
      upstream.destroy();
      const done = (): void => {
        if (directory !== undefined) {
          rmSync(directory, { recursive: true, force: true });
        }
        resolve();
      };
      if (server.listening) server.close(done);
      else done();
    });
    return closing;
  };

  const acceptTimer = setTimeout(() => {
    void close();
  }, options.acceptTimeoutMs ?? DEFAULT_ACCEPT_TIMEOUT_MS);
  acceptTimer.unref();

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (!windows) chmodSync(path, 0o600);
  } catch (error) {
    await close();
    throw new NetworkError(
      'BROKER_UNREACHABLE',
      'the local forwarder could not start',
      { cause: error, retryable: false },
    );
  }

  // An upstream that dies before the client arrives leaves nothing to forward.
  upstream.once('close', () => {
    void close();
  });
  return { path, close };
}
