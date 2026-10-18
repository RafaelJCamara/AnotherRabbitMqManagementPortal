// amqplib 2.2.0 for real, against a stand-in for the Dialer's forwarder: a local endpoint that
// records what connects to it. It proves the claim connect.ts rests on (I-9): given a `path`,
// amqplib opens that endpoint and nothing else, and speaks the AMQP 0-9-1 protocol header on it.
import { randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { connectControl } from './connect.ts';
import { Amqp091Error } from './errors.ts';
import { CANARY_PASSWORD } from './testing/harness.ts';

const endpoint = (): string =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\amqp091-wiring-${randomBytes(8).toString('hex')}`
    : join(tmpdir(), `amqp091-wiring-${randomBytes(8).toString('hex')}.sock`);

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe('the real amqplib driver', () => {
  it('connects to the forwarder path and sends the AMQP 0-9-1 protocol header, never to the host', async () => {
    const path = endpoint();
    const clients: Socket[] = [];
    const received: Buffer[] = [];
    const server = createServer((socket) => {
      clients.push(socket);
      socket.on('data', (chunk: Buffer) => {
        received.push(chunk);
        // Close without answering: the handshake fails, which is all this test needs.
        socket.destroy();
      });
      socket.on('error', () => undefined);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(path, resolve));

    // No `driver` override: the real amqplib driver. The host below does not resolve and the
    // port is closed; if amqplib used either, the error would be ENOTFOUND or ECONNREFUSED.
    const error = await connectControl({
      dialer: {
        forwarder: () =>
          Promise.resolve({
            path,
            close: () => Promise.resolve(),
          }),
      },
      route: { kind: 'direct' },
      endpoint: { host: 'unresolvable.invalid', port: 1 },
      credentials: {
        kind: 'plain',
        username: 'guest',
        password: CANARY_PASSWORD,
      },
      name: { product: 'product', mode: 'local', session: 's1' },
      connectTimeoutMs: 2_000,
    }).catch((caught: unknown) => caught);

    expect(clients).toHaveLength(1);
    expect(Buffer.concat(received).subarray(0, 8)).toEqual(
      Buffer.from([0x41, 0x4d, 0x51, 0x50, 0, 0, 9, 1]),
    );
    expect(error).toBeInstanceOf(Amqp091Error);
    expect((error as Amqp091Error).reason).not.toBe('connect-failed');
    expect(String(error)).not.toContain(CANARY_PASSWORD);
  });
});
