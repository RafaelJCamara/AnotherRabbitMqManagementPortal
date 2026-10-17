import { createServer, type Server } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  isConnectionStart,
  isPeerPropertiesOk,
  probeAmqp,
  probeStream,
  streamPeerPropertiesRequest,
} from './probes.ts';

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** A TCP server that answers every chunk with `reply`. */
function serve(reply: Buffer): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      socket.on('data', () => socket.write(reply));
      socket.on('error', () => undefined);
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

describe('AMQP probe', () => {
  it('accepts a connection.start frame', async () => {
    const port = await serve(
      Buffer.from([1, 0, 0, 0, 0, 0, 4, 0, 10, 0, 10, 0xce]),
    );
    expect(await probeAmqp('127.0.0.1', port)).toMatchObject({ ok: true });
  });

  it('rejects another protocol answering on the port', async () => {
    const port = await serve(Buffer.from('HTTP/1.1 400 Bad Request\r\n\r\n'));
    const check = await probeAmqp('127.0.0.1', port);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('connection.start');
  });

  it('rejects a method frame that is not connection.start', () => {
    // class 10, method 11 is connection.start-ok
    expect(
      isConnectionStart(Buffer.from([1, 0, 0, 0, 0, 0, 4, 0, 10, 0, 11, 0xce])),
    ).toBe(false);
    expect(isConnectionStart(Buffer.from([1, 0, 0]))).toBe(false);
  });

  it('fails when nothing listens', async () => {
    const port = await serve(Buffer.alloc(0));
    servers.pop()?.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await probeAmqp('127.0.0.1', port)).ok).toBe(false);
  });
});

describe('stream probe', () => {
  it('sends a well-formed PeerProperties request', () => {
    const request = streamPeerPropertiesRequest();
    expect(request.readUInt32BE(0)).toBe(request.length - 4);
    expect(request.readUInt16BE(4)).toBe(0x0011);
    expect(request.readUInt32BE(8)).toBe(1);
  });

  it('accepts an ok response and rejects an error code, a wrong key or a wrong correlation id', async () => {
    const response = (
      key: number,
      correlation: number,
      code: number,
    ): Buffer => {
      const reply = Buffer.alloc(14);
      reply.writeUInt32BE(10, 0);
      reply.writeUInt16BE(key, 4);
      reply.writeUInt16BE(1, 6);
      reply.writeUInt32BE(correlation, 8);
      reply.writeUInt16BE(code, 12);
      return reply;
    };
    expect(isPeerPropertiesOk(response(0x8011, 1, 1))).toBe(true);
    expect(isPeerPropertiesOk(response(0x8011, 1, 2))).toBe(false);
    expect(isPeerPropertiesOk(response(0x0011, 1, 1))).toBe(false);
    expect(isPeerPropertiesOk(response(0x8011, 2, 1))).toBe(false);

    const ok = await serve(response(0x8011, 1, 1));
    expect(await probeStream('127.0.0.1', ok)).toMatchObject({ ok: true });
    const bad = await serve(response(0x8011, 1, 2));
    expect((await probeStream('127.0.0.1', bad)).ok).toBe(false);
  });
});
