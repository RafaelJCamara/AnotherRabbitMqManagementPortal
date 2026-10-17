import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tcpConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';

/** The outcome of one reachability check. */
export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export const pass = (name: string, detail: string): Check => ({
  name,
  ok: true,
  detail,
});
export const fail = (name: string, detail: string): Check => ({
  name,
  ok: false,
  detail,
});

/** Turns a thrown error into a message. */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Connects, sends `request`, and collects the reply until `isComplete` accepts it. Rejects on a
 * connection error, an early close or a timeout. `tls` makes it a TLS connection.
 */
export function exchange(options: {
  readonly host: string;
  readonly port: number;
  readonly request: Buffer;
  readonly isComplete: (reply: Buffer) => boolean;
  readonly tls?: ConnectionOptions;
  readonly timeoutMs?: number;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const { host, port } = options;
    let reply = Buffer.alloc(0);
    const finish = (error: Error | null): void => {
      socket.destroy();
      if (error) reject(error);
      else resolve(reply);
    };
    const onConnect = (): void => {
      socket.write(options.request);
    };
    const socket: Socket = options.tls
      ? tlsConnect({ host, port, ...options.tls }, onConnect)
      : tcpConnect({ host, port }, onConnect);
    socket.setTimeout(options.timeoutMs ?? 10_000, () => {
      finish(
        new Error(`no complete reply from ${host}:${String(port)} in time`),
      );
    });
    socket.on('data', (chunk: Buffer) => {
      reply = Buffer.concat([reply, chunk]);
      if (options.isComplete(reply)) finish(null);
    });
    socket.once('error', (error) => {
      finish(error);
    });
    socket.once('close', () => {
      finish(
        new Error(`${host}:${String(port)} closed before a complete reply`),
      );
    });
  });
}

/** AMQP 0-9-1 protocol header. */
const AMQP_HEADER = Buffer.from([0x41, 0x4d, 0x51, 0x50, 0, 0, 9, 1]);

/** True when `reply` starts with a `connection.start` method frame (class 10, method 10). */
export function isConnectionStart(reply: Buffer): boolean {
  return (
    reply.length >= 11 &&
    reply.readUInt8(0) === 1 &&
    reply.readUInt16BE(1) === 0 &&
    reply.readUInt16BE(7) === 10 &&
    reply.readUInt16BE(9) === 10
  );
}

/** Opens an AMQP 0-9-1 connection far enough to see the broker's `connection.start`. */
export async function probeAmqp(
  host: string,
  port: number,
  tls?: ConnectionOptions,
): Promise<Check> {
  const name = tls ? `amqps ${String(port)}` : `amqp ${String(port)}`;
  try {
    await exchange({
      host,
      port,
      request: AMQP_HEADER,
      isComplete: (reply) => reply.length >= 11,
      ...(tls ? { tls } : {}),
    }).then((reply) => {
      if (!isConnectionStart(reply)) {
        throw new Error('the reply is not an AMQP 0-9-1 connection.start');
      }
    });
    return pass(name, 'AMQP 0-9-1 handshake answered with connection.start');
  } catch (error) {
    return fail(name, messageOf(error));
  }
}

const STREAM_PEER_PROPERTIES = 0x0011;
const STREAM_RESPONSE_OK = 1;

/** A stream protocol `PeerProperties` request with no properties and correlation id 1. */
export function streamPeerPropertiesRequest(): Buffer {
  const frame = Buffer.alloc(16);
  frame.writeUInt32BE(12, 0); // size of everything after this field
  frame.writeUInt16BE(STREAM_PEER_PROPERTIES, 4);
  frame.writeUInt16BE(1, 6); // command version
  frame.writeUInt32BE(1, 8); // correlation id
  frame.writeUInt32BE(0, 12); // number of properties
  return frame;
}

/** True when `reply` is a complete, successful `PeerProperties` response for correlation id 1. */
export function isPeerPropertiesOk(reply: Buffer): boolean {
  return (
    reply.length >= 14 &&
    reply.readUInt16BE(4) === (0x8000 | STREAM_PEER_PROPERTIES) &&
    reply.readUInt32BE(8) === 1 &&
    reply.readUInt16BE(12) === STREAM_RESPONSE_OK
  );
}

/** Exchanges peer properties with the stream plugin: the listener speaks the stream protocol. */
export async function probeStream(host: string, port: number): Promise<Check> {
  const name = `stream ${String(port)}`;
  try {
    const reply = await exchange({
      host,
      port,
      request: streamPeerPropertiesRequest(),
      isComplete: (data) => data.length >= 14,
    });
    if (!isPeerPropertiesOk(reply)) {
      throw new Error('the reply is not a successful PeerProperties response');
    }
    return pass(name, 'stream protocol answered PeerProperties with ok');
  } catch (error) {
    return fail(name, messageOf(error));
  }
}

export interface HttpOptions {
  readonly username?: string;
  readonly password?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  /** PEM certificate to trust for an https URL. */
  readonly ca?: string;
}

/** GET a URL with optional basic credentials. Returns the status and body text. */
export function httpGet(
  url: string,
  options: HttpOptions = {},
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.username !== undefined) {
    headers.authorization = `Basic ${Buffer.from(`${options.username}:${options.password ?? ''}`).toString('base64')}`;
  }
  const target = new URL(url);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const request = send(
      target,
      {
        headers,
        timeout: options.timeoutMs ?? 10_000,
        ...(options.ca === undefined ? {} : { ca: options.ca }),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        response.once('error', reject);
      },
    );
    request.once('timeout', () => {
      request.destroy(new Error(`GET ${url} timed out`));
    });
    request.once('error', reject);
    request.end();
  });
}

/** GET a management API path and parse the JSON body. Throws on any status but 200. */
export async function httpJson(
  url: string,
  options: HttpOptions = {},
): Promise<unknown> {
  const { status, body } = await httpGet(url, options);
  if (status !== 200) {
    throw new Error(`GET ${url} answered ${String(status)}`);
  }
  return JSON.parse(body) as unknown;
}
