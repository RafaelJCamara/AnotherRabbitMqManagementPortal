// Trust failures and diagnostics, through the same `secureSocket` the Dialer uses.
import { connect as tcpConnect, createServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createTestPki,
  issueCertificate,
  startTestTlsServer,
  type TestPki,
  type TestTlsServer,
} from './testing/index.ts';

import { classifyTlsError, describeCertificate } from './diagnostics.ts';
import { NetworkError } from './errors.ts';
import { secureSocket } from './handshake.ts';
import { createTrustStore, type TlsTrust } from './truststore.ts';

const DAY_MS = 86_400_000;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function serve(certPem: string, keyPem: string): Promise<TestTlsServer> {
  const server = await startTestTlsServer({ certPem, keyPem });
  closers.push(() => server.close());
  return server;
}

async function serveFrom(
  pki: TestPki,
  options: Parameters<TestPki['issueServer']>[0] = {},
): Promise<TestTlsServer> {
  const { leaf, chainPem } = pki.issueServer(options);
  return serve(chainPem, leaf.keyPem);
}

function tcp(server: { host: string; port: number }): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect({ host: server.host, port: server.port }, () => {
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

/** A plain TCP server on a free loopback port; its sockets are destroyed at the end of the test. */
async function plainServer(
  onConnection: (socket: Socket) => void,
): Promise<number> {
  const open = new Set<Socket>();
  const server = createServer((socket) => {
    open.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => open.delete(socket));
    onConnection(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => {
          resolve();
        });
      }),
  );
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('no port');
  return address.port;
}

const store = createTrustStore({
  includeSystem: false,
  runtime: {
    getCACertificates: () => [],
    setDefaultCACertificates: () => undefined,
  },
});

async function failure(
  server: TestTlsServer,
  trust: TlsTrust,
  hint?: string,
): Promise<NetworkError> {
  const socket = await tcp(server);
  try {
    await secureSocket(
      socket,
      trust,
      server.host,
      hint === undefined ? {} : { hint },
    );
  } catch (error) {
    expect(socket.destroyed).toBe(true);
    expect(error).toBeInstanceOf(NetworkError);
    return error as NetworkError;
  }
  throw new Error('the handshake was expected to fail');
}

describe('trust failures are refused, with the reason', () => {
  it('an untrusted CA: the issuer is not in the store', async () => {
    const pki = createTestPki();
    const server = await serveFrom(pki);

    const error = await failure(server, store.forProfile(), 'localhost');

    expect(error.code).toBe('TLS_UNTRUSTED');
    expect(error.retryable).toBe(false);
    expect(classifyTlsError(error.tls?.nodeCode)).toBe('untrusted-issuer');
    expect(error.tls?.verifiedName).toBe('localhost');
    expect(error.detail).toContain('issuer is not trusted');
  });

  it('a different CA in the profile does not vouch for the server', async () => {
    const server = await serveFrom(createTestPki('Server CA'));
    const trust = store.forProfile({
      ca: [createTestPki('Other CA').root.pem],
    });

    const error = await failure(server, trust, 'localhost');

    expect(error.code).toBe('TLS_UNTRUSTED');
    expect(classifyTlsError(error.tls?.nodeCode)).toBe('untrusted-issuer');
  });

  it('a self-signed server certificate that is not in the store', async () => {
    const own = issueCertificate({
      commonName: 'self',
      dnsNames: ['localhost'],
      ipAddresses: ['127.0.0.1'],
    });
    const server = await serve(own.pem, own.keyPem);

    const error = await failure(server, store.forProfile(), 'localhost');

    expect(error.code).toBe('TLS_UNTRUSTED');
    expect(classifyTlsError(error.tls?.nodeCode)).toBe('self-signed');
  });

  it('a self-signed certificate is trusted once the profile imports it', async () => {
    const own = issueCertificate({
      commonName: 'self',

      dnsNames: ['localhost'],
      ipAddresses: ['127.0.0.1'],
    });
    const server = await serve(own.pem, own.keyPem);

    const result = await secureSocket(
      await tcp(server),
      store.forProfile({ ca: [own.pem] }),
      server.host,
      { hint: 'localhost' },
    );
    result.socket.destroy();

    expect(result.diagnostics.verified).toBe(true);
  });

  it('a hostname mismatch: the certificate names another host', async () => {
    const pki = createTestPki();
    const server = await serveFrom(pki, {
      dnsNames: ['other.example.test'],
      ipAddresses: [],
    });
    const trust = store.forProfile({ ca: [pki.root.pem] });

    const error = await failure(server, trust, 'broker.example.test');

    expect(error.code).toBe('TLS_UNTRUSTED');
    expect(classifyTlsError(error.tls?.nodeCode)).toBe('hostname-mismatch');
    expect(error.tls?.verifiedName).toBe('broker.example.test');
  });

  it('dialling by IP fails when the certificate has no IP address, and the override cannot hide a wrong name', async () => {
    const pki = createTestPki();
    const server = await serveFrom(pki, {
      dnsNames: ['broker.lab.test'],
      ipAddresses: [],
    });

    const byIp = await failure(
      server,
      store.forProfile({ ca: [pki.root.pem] }),
    );
    const wrongOverride = await failure(
      server,
      store.forProfile({
        ca: [pki.root.pem],
        servername: 'elsewhere.lab.test',
      }),
    );

    expect(classifyTlsError(byIp.tls?.nodeCode)).toBe('hostname-mismatch');
    expect(byIp.tls?.verifiedName).toBe('127.0.0.1');
    expect(classifyTlsError(wrongOverride.tls?.nodeCode)).toBe(
      'hostname-mismatch',
    );
  });

  it('an expired certificate', async () => {
    const pki = createTestPki();
    const server = await serveFrom(pki, {
      notBefore: new Date(Date.now() - 10 * DAY_MS),
      notAfter: new Date(Date.now() - DAY_MS),
    });

    const error = await failure(
      server,
      store.forProfile({ ca: [pki.root.pem] }),
      'localhost',
    );

    expect(error.code).toBe('TLS_UNTRUSTED');
    expect(classifyTlsError(error.tls?.nodeCode)).toBe('expired');
    expect(error.detail).toContain('expired');
  });

  it('a certificate that is not valid yet', async () => {
    const pki = createTestPki();
    const server = await serveFrom(pki, {
      notBefore: new Date(Date.now() + DAY_MS),
      notAfter: new Date(Date.now() + 10 * DAY_MS),
    });

    const error = await failure(
      server,
      store.forProfile({ ca: [pki.root.pem] }),
      'localhost',
    );

    expect(classifyTlsError(error.tls?.nodeCode)).toBe('not-yet-valid');
  });

  it('an expired intermediate breaks the chain even when the leaf is fresh', async () => {
    const root = issueCertificate({ commonName: 'Root', isCa: true });
    const intermediate = issueCertificate({
      commonName: 'Old Intermediate',
      isCa: true,
      issuer: root,
      notBefore: new Date(Date.now() - 10 * DAY_MS),
      notAfter: new Date(Date.now() - DAY_MS),
    });
    const leaf = issueCertificate({
      commonName: 'leaf',
      dnsNames: ['localhost'],
      issuer: intermediate,
    });
    const server = await serve(leaf.pem + intermediate.pem, leaf.keyPem);

    const error = await failure(
      server,
      store.forProfile({ ca: [root.pem] }),
      'localhost',
    );

    expect(classifyTlsError(error.tls?.nodeCode)).toBe('expired');
  });

  it('does not treat a pinned-looking fingerprint as a reason to refuse: only trust decides', async () => {
    // DC-44: no leaf pinning. A different leaf from the same CA verifies.
    const pki = createTestPki();
    const trust = store.forProfile({ ca: [pki.root.pem] });

    const one = await secureSocket(
      await tcp(await serveFrom(pki)),
      trust,
      '127.0.0.1',
    );
    const two = await secureSocket(
      await tcp(await serveFrom(pki)),
      trust,
      '127.0.0.1',
    );
    one.socket.destroy();
    two.socket.destroy();

    expect(one.diagnostics.chain[0]?.fingerprint256).not.toBe(
      two.diagnostics.chain[0]?.fingerprint256,
    );
    expect(one.diagnostics.verified && two.diagnostics.verified).toBe(true);
  });

  it('a plaintext port is not reported as an untrusted certificate', async () => {
    const port = await plainServer((socket) => {
      socket.once('data', () => {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      });
    });

    const error = await failure(
      { host: '127.0.0.1', port } as TestTlsServer,
      store.forProfile(),
      'localhost',
    );

    expect(error.code).toBe('BROKER_UNREACHABLE');
    expect(error.tls).toBeUndefined();
  });

  it('the error text never carries certificate bodies or keys', async () => {
    const pki = createTestPki();
    const server = await serveFrom(pki);

    const error = await failure(server, store.forProfile(), 'localhost');

    expect(error.message).not.toContain('BEGIN');
    expect(JSON.stringify(error)).not.toContain('PRIVATE');
  });

  it('stops the handshake when the signal aborts', async () => {
    const port = await plainServer(() => undefined);
    const socket = await tcp({ host: '127.0.0.1', port });
    const controller = new AbortController();

    const pending = secureSocket(socket, store.forProfile(), '127.0.0.1', {
      signal: controller.signal,
    });
    controller.abort(new Error('caller gave up'));

    await expect(pending).rejects.toThrow('caller gave up');
    expect(socket.destroyed).toBe(true);
  });
});

describe('diagnostics', () => {
  it('describes the chain, names, expiry and SNI of a verified connection', async () => {
    const pki = createTestPki('Corp Root');
    const server = await serveFrom(pki, {
      commonName: 'broker-1',
      dnsNames: ['broker.lab.test', 'alt.lab.test'],
      ipAddresses: ['127.0.0.1'],
    });
    const trust = store.forProfile({
      ca: [pki.root.pem],
      servername: 'broker.lab.test',
    });

    const { socket, diagnostics } = await secureSocket(
      await tcp(server),
      trust,
      server.host,
    );
    socket.destroy();

    expect(diagnostics.verified).toBe(true);
    expect(diagnostics.failure).toBeUndefined();
    expect(diagnostics.authorizationError).toBeUndefined();
    expect(diagnostics.sanMatches).toBe(true);
    expect(diagnostics.sni).toBe('broker.lab.test');
    expect(diagnostics.protocol).toMatch(/^TLSv1\.[23]$/);
    expect(diagnostics.cipher).toBeTruthy();
    expect(diagnostics.chain.map((entry) => entry.subject)).toEqual([
      'CN=broker-1',
      'CN=Corp Root Intermediate',
      'CN=Corp Root',
    ]);
    expect(diagnostics.chain.map((entry) => entry.isCa)).toEqual([
      false,
      true,
      true,
    ]);
    expect(diagnostics.chain[0]?.subjectAltNames).toEqual([
      'DNS:broker.lab.test',
      'DNS:alt.lab.test',
      'IP Address:127.0.0.1',
    ]);
    expect(diagnostics.chain[2]?.selfSigned).toBe(true);
    expect(diagnostics.chain[0]?.selfSigned).toBe(false);
    expect(diagnostics.notAfter).toBe(diagnostics.chain[0]?.validTo);
  });

  it('with verification off, still says why the chain would have failed', async () => {
    const server = await serveFrom(createTestPki(), {
      dnsNames: ['somewhere.else.test'],
      ipAddresses: [],
    });
    const { socket, diagnostics } = await secureSocket(
      await tcp(server),
      store.forProfile({ insecure: true }),
      server.host,
      { hint: 'broker.lab.test' },
    );
    socket.destroy();

    expect(diagnostics.verified).toBe(false);
    expect(diagnostics.insecureOverride).toBe(true);
    expect(classifyTlsError(diagnostics.authorizationError)).toBe(
      'untrusted-issuer',
    );
    expect(diagnostics.failure).toBe('untrusted-issuer');
    expect(diagnostics.sanMatches).toBe(false);
    expect(diagnostics.chain.length).toBeGreaterThanOrEqual(1);
  });

  it('classifies verification codes, and leaves non-certificate failures unclassified', () => {
    expect(classifyTlsError('CERT_HAS_EXPIRED')).toBe('expired');
    expect(classifyTlsError('CERT_NOT_YET_VALID')).toBe('not-yet-valid');
    expect(classifyTlsError('ERR_TLS_CERT_ALTNAME_INVALID')).toBe(
      'hostname-mismatch',
    );
    expect(classifyTlsError('DEPTH_ZERO_SELF_SIGNED_CERT')).toBe('self-signed');
    expect(classifyTlsError('SELF_SIGNED_CERT_IN_CHAIN')).toBe('self-signed');
    expect(classifyTlsError('UNABLE_TO_VERIFY_LEAF_SIGNATURE')).toBe(
      'untrusted-issuer',
    );
    expect(classifyTlsError('CERT_REVOKED')).toBe('revoked');
    expect(classifyTlsError('ECONNRESET')).toBeUndefined();
    expect(classifyTlsError('ERR_SSL_WRONG_VERSION_NUMBER')).toBeUndefined();
    expect(classifyTlsError(undefined)).toBeUndefined();
  });

  it('summarises a certificate from its DER bytes', () => {
    const cert = issueCertificate({
      commonName: 'summary',
      dnsNames: ['a.test'],
      notBefore: new Date('2024-01-01T00:00:00Z'),
      notAfter: new Date('2051-01-01T00:00:00Z'),
    });

    const summary = describeCertificate({ raw: cert.x509.raw });

    expect(summary.subject).toBe('CN=summary');
    expect(summary.validFrom).toBe(Date.parse('2024-01-01T00:00:00Z'));
    expect(summary.validTo).toBe(Date.parse('2051-01-01T00:00:00Z'));
    expect(summary.subjectAltNames).toEqual(['DNS:a.test']);
    expect(summary.fingerprint256).toBe(cert.fingerprint256);
  });
});
