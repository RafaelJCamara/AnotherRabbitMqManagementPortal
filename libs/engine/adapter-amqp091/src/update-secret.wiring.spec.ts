// amqplib 2.2.0 for real, against a scripted stand-in for a broker (no Docker): it speaks just enough
// AMQP 0-9-1 to finish the handshake and then answers `connection.update-secret` with
// `update-secret-ok` or, as a broker that refuses the secret does, with `connection.close`. It shows
// what the unit specs only assume of the library: the secret must be sent as bytes and arrives
// intact, a refusal never rejects the library's promise by itself (the adapter ends it when the
// connection closes), and a 320 close reaches subscribers with its code. The stand-in is written
// from the protocol and from reading amqplib, not recorded from a RabbitMQ node: whether a real
// broker answers a refusal this way is for the lab (AC-24, OQ-1574).
import { randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ConnectorEvent } from '@app/ports';

import { connectControl } from './connect.ts';
import { Amqp091Error } from './errors.ts';

const endpoint = (): string =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\amqp091-secret-${randomBytes(8).toString('hex')}`
    : join(tmpdir(), `amqp091-secret-${randomBytes(8).toString('hex')}.sock`);

const SECRET = 'eyJhbGciOi.wire-canary-7d1e.sig';

const u16 = (n: number): Buffer => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const longstr = (text: string): Buffer =>
  Buffer.concat([u32(Buffer.byteLength(text)), Buffer.from(text)]);
const shortstr = (text: string): Buffer =>
  Buffer.concat([Buffer.from([Buffer.byteLength(text)]), Buffer.from(text)]);

/** A method frame on channel 0. */
const method = (classId: number, methodId: number, args: Buffer[]): Buffer => {
  const payload = Buffer.concat([u16(classId), u16(methodId), ...args]);
  return Buffer.concat([
    Buffer.from([1]),
    u16(0),
    u32(payload.length),
    payload,
    Buffer.from([0xce]),
  ]);
};

type Answer = 'ok' | { close: number; text: string } | 'silence';

interface Broker {
  readonly path: string;
  /** The (secret, reason) pairs it was sent, decoded from the wire. */
  readonly updates: { secret: string; reason: string }[];
  answer: Answer;
}

const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) server.close();
});

async function startBroker(answer: Answer): Promise<Broker> {
  const broker: Broker = { path: endpoint(), updates: [], answer };
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => undefined);
    let pending = Buffer.alloc(0);
    let greeted = false;
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (!greeted) {
        if (pending.length < 8) return;
        pending = pending.subarray(8);
        greeted = true;
        socket.write(
          method(10, 10, [
            Buffer.from([0, 9]),
            u32(0),
            longstr('PLAIN'),
            longstr('en_US'),
          ]),
        );
      }
      for (;;) {
        if (pending.length < 7) return;
        const size = pending.readUInt32BE(3);
        if (pending.length < 7 + size + 1) return;
        const frame = pending.subarray(7, 7 + size);
        const type = pending[0];
        pending = pending.subarray(7 + size + 1);
        if (type !== 1) continue;
        // Every method of this exchange is in class 10 (connection); the method id tells them apart.
        const methodId = frame.readUInt16BE(2);
        if (methodId === 11) {
          // start-ok: tune with no channel limit, 128 KiB frames, no heartbeat
          socket.write(method(10, 30, [u16(0), u32(131_072), u16(0)]));
        } else if (methodId === 40) {
          socket.write(method(10, 41, [shortstr('')]));
        } else if (methodId === 50) {
          socket.write(method(10, 51, []));
        } else if (methodId === 70) {
          const length = frame.readUInt32BE(4);
          const secret = frame.subarray(8, 8 + length).toString('utf8');
          const reasonLength = frame[8 + length] ?? 0;
          const reason = frame
            .subarray(9 + length, 9 + length + reasonLength)
            .toString('utf8');
          broker.updates.push({ secret, reason });
          if (broker.answer === 'ok') {
            socket.write(method(10, 71, []));
          } else if (broker.answer !== 'silence') {
            socket.write(
              method(10, 50, [
                u16(broker.answer.close),
                shortstr(broker.answer.text),
                u16(10),
                u16(70),
              ]),
            );
          }
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(broker.path, resolve));
  return broker;
}

const connect = (broker: Broker) =>
  connectControl({
    dialer: {
      forwarder: () =>
        Promise.resolve({ path: broker.path, close: () => Promise.resolve() }),
    },
    route: { kind: 'direct' },
    endpoint: { host: 'unresolvable.invalid', port: 1 },
    credentials: () => ({ kind: 'plain', username: 'guest', password: 'pw' }),
    name: { product: 'product', mode: 'local', session: 's1' },
    connectTimeoutMs: 5_000,
    operationTimeoutMs: 5_000,
  });

describe('M1-23 slice E1 amqplib on the wire', () => {
  it('sends the secret and the reason as bytes and resolves on update-secret-ok', async () => {
    const broker = await startBroker('ok');
    const opened = await connect(broker);
    await opened.updateSecret(SECRET, 'token-refresh');
    await opened.updateSecret('tök€n-🐇', 'again');
    expect(broker.updates).toEqual([
      { secret: SECRET, reason: 'token-refresh' },
      { secret: 'tök€n-🐇', reason: 'again' },
    ]);
    await opened.lease.release('healthy');
  });

  it('a broker that closes over the secret ends the update as a refusal and tells subscribers the code', async () => {
    const broker = await startBroker({
      close: 530,
      text: `NOT_ALLOWED - New secret was refused by one of the backends: mismatch_username_after_token_refresh ${SECRET}`,
    });
    const opened = await connect(broker);
    const events: ConnectorEvent[] = [];
    opened.subscribe((event) => events.push(event));
    const error = await opened.updateSecret(SECRET, 'refresh').then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Amqp091Error);
    const refused = error as Amqp091Error;
    expect(refused.reason).toBe('secret-refused');
    expect(refused.detail).toContain('the user name differs');
    expect(refused.broker).toEqual({ protocol: 'amqp091', code: 530 });
    expect(JSON.stringify(refused)).not.toContain(SECRET);
    expect(refused.stack ?? '').not.toContain(SECRET);
    expect(events.find((event) => event.type === 'closed')?.code).toBe(530);
    expect(broker.updates).toEqual([{ secret: SECRET, reason: 'refresh' }]);
  });

  it('a 320 close (a token that ran out) is retryable and carries its code', async () => {
    const broker = await startBroker({
      close: 320,
      text: 'CONNECTION_FORCED - credential expired',
    });
    const opened = await connect(broker);
    const events: ConnectorEvent[] = [];
    opened.subscribe((event) => events.push(event));
    const error = (await opened.updateSecret(SECRET, 'refresh').then(
      () => undefined,
      (caught: unknown) => caught,
    )) as Amqp091Error;
    expect(error.reason).toBe('broker-error');
    expect(error.retryable).toBe(true);
    expect(events.find((event) => event.type === 'closed')?.code).toBe(320);
  });

  it('a broker that never answers ends with the operation timeout, not a hang', async () => {
    const broker = await startBroker('silence');
    const opened = await connectControl({
      dialer: {
        forwarder: () =>
          Promise.resolve({
            path: broker.path,
            close: () => Promise.resolve(),
          }),
      },
      route: { kind: 'direct' },
      endpoint: { host: 'unresolvable.invalid', port: 1 },
      credentials: { kind: 'plain', username: 'guest', password: 'pw' },
      name: { product: 'product', mode: 'local', session: 's1' },
      connectTimeoutMs: 5_000,
      operationTimeoutMs: 100,
    });
    const error = (await opened.updateSecret(SECRET, 'refresh').then(
      () => undefined,
      (caught: unknown) => caught,
    )) as Amqp091Error;
    expect(error.reason).toBe('timeout');
  });
});
