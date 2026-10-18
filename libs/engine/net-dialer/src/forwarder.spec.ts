import { existsSync, statSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NetworkError } from '@app/net-truststore';

import { createDialer } from './dialer.ts';
import {
  acceptedAfterSettling,
  readAll,
  startPlainServer,
  type PlainServer,
} from './test-support.ts';

const DIRECT = { kind: 'direct' } as const;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function upstream(
  onConnection?: Parameters<typeof startPlainServer>[0],
): Promise<PlainServer> {
  const server = await startPlainServer(onConnection);
  closers.push(() => server.close());
  return server;
}

const clientOf = (path: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect({ path }, () => {
      resolve(socket);
    });
    socket.once('error', reject);
  });

const to = (port: number) => ({ host: '127.0.0.1', port, purpose: 'amqp' });

describe('forwarder (route direct)', () => {
  it('carries one client’s bytes to the target and back through a local path', async () => {
    const server = await upstream();
    const forwarder = await createDialer().forwarder(to(server.port), DIRECT);
    closers.push(() => forwarder.close());

    const client = await clientOf(forwarder.path);
    client.write('hello');
    const echoed = await readAll(client, 5);
    client.destroy();

    expect(echoed).toBe('hello');
    await vi.waitFor(() => {
      expect(server.accepted()).toBe(1);
    });
  });

  it('serves exactly one client: a second one is dropped before it reaches the target', async () => {
    const received: string[] = [];
    const server = await upstream((socket) => {
      socket.on('data', (chunk: Buffer) => {
        received.push(chunk.toString());
        socket.write(chunk);
      });
    });
    const forwarder = await createDialer().forwarder(to(server.port), DIRECT);
    closers.push(() => forwarder.close());
    const first = await clientOf(forwarder.path);
    first.write('one');
    expect(await readAll(first, 3)).toBe('one');

    // Depending on the platform the second connection is refused, dropped at once, or (a Windows
    // named pipe) left waiting for an instance that never comes.
    const attempt = clientOf(forwarder.path).catch(() => undefined);
    const second = await Promise.race([
      attempt,
      new Promise<undefined>((resolve) => setTimeout(resolve, 300, undefined)),
    ]);
    second?.on('error', () => undefined);
    second?.write('two');
    // On a Windows named pipe the extra client may simply never be served, so do not wait for it.
    const reply =
      second === undefined
        ? ''
        : await Promise.race([
            readAll(second),
            new Promise<string>((resolve) => setTimeout(resolve, 300, '')),
          ]);
    second?.destroy();
    first.destroy();

    expect(reply).toBe('');
    expect(received.join('')).toBe('one');
    await vi.waitFor(() => {
      expect(server.accepted()).toBe(1);
    });
  });
  it('uses no TCP port and, on Unix, a private directory and a 0600 socket', async () => {
    const server = await upstream();
    const forwarder = await createDialer().forwarder(to(server.port), DIRECT);
    closers.push(() => forwarder.close());

    if (process.platform === 'win32') {
      expect(forwarder.path).toMatch(/^\\\\\.\\pipe\\app-fwd-[0-9a-f]{32}$/);
    } else {
      expect(statSync(forwarder.path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(forwarder.path)).mode & 0o777).toBe(0o700);
    }
  });

  it('close() is idempotent, removes the socket and drops the upstream connection', async () => {
    const server = await upstream();
    const forwarder = await createDialer().forwarder(to(server.port), DIRECT);

    await forwarder.close();
    await forwarder.close();

    await expect(clientOf(forwarder.path)).rejects.toThrow();
    if (process.platform !== 'win32') {
      expect(existsSync(dirname(forwarder.path))).toBe(false);
    }
  });

  it('closes itself when no client arrives in time', async () => {
    const server = await upstream();
    const dialer = createDialer();
    const { openForwarder } = await import('./forwarder.ts');
    const socket = await dialer.connect(to(server.port), DIRECT);

    const forwarder = await openForwarder(socket, { acceptTimeoutMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 150));

    await expect(clientOf(forwarder.path)).rejects.toThrow();
    expect(socket.destroyed).toBe(true);
  });

  it('closes the client when the target hangs up', async () => {
    const server = await upstream((socket) => {
      socket.once('data', () => {
        socket.end('bye');
      });
    });
    const forwarder = await createDialer().forwarder(to(server.port), DIRECT);
    closers.push(() => forwarder.close());
    const client = await clientOf(forwarder.path);

    client.write('x');
    const reply = await readAll(client);

    expect(reply).toBe('bye');
    expect(client.destroyed || client.readableEnded).toBe(true);
  });

  it('applies the egress policy and reports a refusal from forwarder() itself', async () => {
    const server = await upstream();
    const dialer = createDialer({
      policy: { evaluate: () => ({ allowed: false, reason: 'no' }) },
    });

    const error = await dialer
      .forwarder(to(server.port), DIRECT)
      .catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).code).toBe('EGRESS_DENIED');
    expect(await acceptedAfterSettling(server)).toBe(0);
  });

  it('refuses a target with TLS settings: a forwarder carries raw bytes', async () => {
    const server = await upstream();

    const error = await createDialer()
      .forwarder({ ...to(server.port), tls: {} } as never, DIRECT)
      .catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).code).toBe('VALIDATION_FAILED');
    expect(await acceptedAfterSettling(server)).toBe(0);
  });

  it('only the direct route exists', async () => {
    const server = await upstream();

    const error = await createDialer()
      .forwarder(to(server.port), { kind: 'ssh2' })
      .catch((failure: unknown) => failure);

    expect((error as NetworkError).code).toBe('VALIDATION_FAILED');
  });
});
