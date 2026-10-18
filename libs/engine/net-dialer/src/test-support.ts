// Helpers shared by the specs of this project. Not exported by index.ts.
import { createServer, type Socket } from 'node:net';

import {
  createTrustStore,
  type TlsRuntime,
  type TrustStore,
} from '@app/net-truststore';

/** A trust store with no system or bundled CAs: only what a test imports is trusted. */
export function emptyTrustStore(): TrustStore {
  const runtime: TlsRuntime = {
    getCACertificates: () => [],
    setDefaultCACertificates: () => undefined,
  };
  return createTrustStore({ runtime });
}

export interface PlainServer {
  readonly port: number;
  /** Connections accepted so far. */
  readonly accepted: () => number;
  close(): Promise<void>;
}

/** A TCP server on 127.0.0.1; `onConnection` defaults to echoing. */
export async function startPlainServer(
  onConnection: (socket: Socket) => void = (socket) => {
    socket.pipe(socket);
  },
): Promise<PlainServer> {
  const open = new Set<Socket>();
  let accepted = 0;
  const server = createServer((socket) => {
    accepted += 1;
    open.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => open.delete(socket));
    onConnection(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the test server has no TCP address');
  }
  return {
    port: address.port,
    accepted: () => accepted,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * The number of connections a server saw once in-flight ones have been noticed. A client can
 * report "connected" before the server's accept callback runs, so a plain read of `accepted()`
 * right after a connect can say 0 for a connection that did happen. Use this for "no connection
 * was made" assertions, and `vi.waitFor` for "exactly one was made".
 */
export async function acceptedAfterSettling(
  server: { accepted(): number },
  settleMs = 100,
): Promise<number> {
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  return server.accepted();
}

/** Reads until the peer ends the stream or `length` bytes arrived. */
export function readAll(socket: Socket, length = Infinity): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    socket.setEncoding('utf8');
    const finish = (): void => {
      resolve(text);
    };
    socket.on('data', (chunk: string) => {
      text += chunk;
      if (text.length >= length) finish();
    });
    socket.once('end', finish);
    socket.once('close', finish);
    socket.once('error', reject);
  });
}
