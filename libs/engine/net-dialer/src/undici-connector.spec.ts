import type { Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NetworkError } from '@app/net-truststore';
import {
  createTestPki,
  startTestTlsServer,
  type TestTlsServer,
} from '@app/net-truststore/testing';

import { createDialer } from './dialer.ts';
import {
  acceptedAfterSettling,
  emptyTrustStore,
  readAll,
  startPlainServer,
  type PlainServer,
} from './test-support.ts';
import {
  createUndiciConnector,
  type ConnectorOptions,
} from './undici-connector.ts';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

function run(
  connector: ReturnType<typeof createUndiciConnector>,
  options: ConnectorOptions,
): Promise<{ error: Error | null; socket: Socket | null; calls: number }> {
  return new Promise((resolve) => {
    let calls = 0;
    connector(options, (error, socket) => {
      calls += 1;
      // Give a second (wrong) call the chance to arrive before judging.
      setTimeout(() => {
        resolve({ error, socket, calls });
      }, 20);
    });
  });
}

const HTTP_REQUEST = 'GET /api/overview HTTP/1.1\r\nhost: broker\r\n\r\n';

describe('undici connector', () => {
  it('opens an https origin through the Dialer and the profile trust', async () => {
    const pki = createTestPki();
    const { leaf, chainPem } = pki.issueServer({
      dnsNames: ['broker.lab.test'],
      ipAddresses: [],
    });
    const server: TestTlsServer = await startTestTlsServer({
      certPem: chainPem,
      keyPem: leaf.keyPem,
    });
    closers.push(() => server.close());
    const connector = createUndiciConnector({
      dialer: createDialer(),
      purpose: 'mgmt-http',
      tls: emptyTrustStore().forProfile({
        ca: [pki.root.pem],
        servername: 'broker.lab.test',
      }),
    });

    // undici would pass the origin's own host name; here it is an IP, as for a tunnelled broker.
    const { error, socket, calls } = await run(connector, {
      hostname: '127.0.0.1',
      protocol: 'https:',
      port: String(server.port),
      servername: '127.0.0.1',
    });
    socket?.write(HTTP_REQUEST);
    const reply = socket === null ? '' : await readAll(socket);

    expect(error).toBeNull();
    expect(calls).toBe(1);
    expect(socket).toBeInstanceOf(TLSSocket);
    expect(reply).toContain('200 OK');
  });

  it('uses undici’s server name when the profile has no override', async () => {
    const pki = createTestPki();
    const { leaf, chainPem } = pki.issueServer({
      dnsNames: ['mgmt.lab.test'],
      ipAddresses: [],
    });
    const server = await startTestTlsServer({
      certPem: chainPem,
      keyPem: leaf.keyPem,
    });
    closers.push(() => server.close());
    const connector = createUndiciConnector({
      dialer: createDialer(),
      purpose: 'mgmt-http',
      tls: emptyTrustStore().forProfile({ ca: [pki.root.pem] }),
    });

    const ok = await run(connector, {
      hostname: '127.0.0.1',
      protocol: 'https:',
      port: server.port,
      servername: 'mgmt.lab.test',
    });
    ok.socket?.destroy();
    const wrong = await run(connector, {
      hostname: '127.0.0.1',
      protocol: 'https:',
      port: server.port,
      servername: 'other.lab.test',
    });

    expect(ok.error).toBeNull();
    expect(wrong.error).toBeInstanceOf(NetworkError);
    expect((wrong.error as NetworkError).code).toBe('TLS_UNTRUSTED');
    expect(wrong.socket).toBeNull();
  });

  it('passes the trust failure to the callback exactly once', async () => {
    const pki = createTestPki();
    const { leaf, chainPem } = pki.issueServer();
    const server = await startTestTlsServer({
      certPem: chainPem,
      keyPem: leaf.keyPem,
    });
    closers.push(() => server.close());
    const connector = createUndiciConnector({
      dialer: createDialer(),
      purpose: 'mgmt-http',
      tls: emptyTrustStore().forProfile(),
    });

    const { error, socket, calls } = await run(connector, {
      hostname: 'localhost',
      protocol: 'https:',
      port: server.port,
    });

    expect(calls).toBe(1);
    expect(socket).toBeNull();
    expect((error as NetworkError).code).toBe('TLS_UNTRUSTED');
  });

  it('opens a plain http origin without TLS', async () => {
    const server: PlainServer = await startPlainServer((socket) => {
      socket.once('data', () => {
        socket.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok');
      });
    });
    closers.push(() => server.close());
    const connector = createUndiciConnector({
      dialer: createDialer(),
      purpose: 'prometheus',
      tls: emptyTrustStore().forProfile(),
    });

    const { error, socket } = await run(connector, {
      hostname: '127.0.0.1',
      protocol: 'http:',
      port: String(server.port),
    });
    socket?.write(HTTP_REQUEST);
    const reply = socket === null ? '' : await readAll(socket);

    expect(error).toBeNull();
    expect(socket).not.toBeInstanceOf(TLSSocket);
    expect(reply).toContain('200 OK');
  });

  it('is subject to the egress policy and names the purpose it was created with', async () => {
    const server = await startPlainServer();
    closers.push(() => server.close());
    const evaluate = vi.fn(() => ({ allowed: false as const, reason: 'no' }));
    const connector = createUndiciConnector({
      dialer: createDialer({ policy: { evaluate } }),
      purpose: 'oidc-discovery',
      tls: emptyTrustStore().forProfile(),
    });

    const { error } = await run(connector, {
      hostname: '127.0.0.1',
      protocol: 'http:',
      port: server.port,
    });

    expect((error as NetworkError).code).toBe('EGRESS_DENIED');
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'oidc-discovery', port: server.port }),
    );
    expect(await acceptedAfterSettling(server)).toBe(0);
  });

  it('refuses a Unix socket path: only hosts are dialled', async () => {
    const connector = createUndiciConnector({
      dialer: createDialer(),
      purpose: 'mgmt-http',
      tls: emptyTrustStore().forProfile(),
    });

    const { error, socket } = await run(connector, {
      hostname: 'localhost',
      protocol: 'http:',
      port: '80',
      httpSocketPath: '/var/run/docker.sock',
    });

    expect((error as NetworkError).code).toBe('VALIDATION_FAILED');
    expect(socket).toBeNull();
  });

  it.each(['ftp:', 'ws:', 'HTTPS:', ''])(
    'refuses the scheme %j instead of guessing plaintext',
    async (protocol) => {
      const server = await startPlainServer();
      closers.push(() => server.close());
      const connector = createUndiciConnector({
        dialer: createDialer(),
        purpose: 'mgmt-http',
        tls: emptyTrustStore().forProfile(),
      });

      const { error, socket } = await run(connector, {
        hostname: '127.0.0.1',
        protocol,
        port: server.port,
      });

      expect((error as NetworkError).code).toBe('VALIDATION_FAILED');
      expect(socket).toBeNull();
      expect(await acceptedAfterSettling(server)).toBe(0);
    },
  );

  it('destroys the socket when undici’s callback throws, and does not crash', async () => {
    const server = await startPlainServer();
    closers.push(() => server.close());
    const connector = createUndiciConnector({
      dialer: createDialer(),
      purpose: 'mgmt-http',
      tls: emptyTrustStore().forProfile(),
    });
    const sockets: Socket[] = [];

    connector(
      { hostname: '127.0.0.1', protocol: 'http:', port: server.port },
      (_error, socket) => {
        if (socket !== null) sockets.push(socket);
        throw new Error('callback bug');
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.destroyed).toBe(true);
  });

  it('defaults the port from the protocol when undici passes none', async () => {
    const seen: number[] = [];
    const connector = createUndiciConnector({
      dialer: {
        dial: (target) => {
          seen.push(target.port);
          return Promise.reject(new Error('stop'));
        },
      },
      purpose: 'mgmt-http',
      tls: emptyTrustStore().forProfile(),
    });

    await run(connector, { hostname: 'a.test', protocol: 'https:', port: '' });
    await run(connector, { hostname: 'a.test', protocol: 'http:', port: '' });

    expect(seen).toEqual([443, 80]);
  });
});
