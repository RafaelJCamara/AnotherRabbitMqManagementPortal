// The test PKI is what every trust test stands on, so it is checked against Node's own verifier.
import { connect as tlsConnect } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createTestPki,
  issueCertificate,
  startTestTlsServer,
  type TestTlsServer,
} from './index.ts';

const servers: TestTlsServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('test PKI', () => {
  it('issues a chain Node accepts: root signs intermediate signs leaf', () => {
    const pki = createTestPki();
    const { leaf } = pki.issueServer();

    expect(pki.root.x509.ca).toBe(true);
    expect(pki.intermediate.x509.ca).toBe(true);
    expect(leaf.x509.ca).toBe(false);
    expect(pki.intermediate.x509.verify(pki.root.x509.publicKey)).toBe(true);
    expect(leaf.x509.verify(pki.intermediate.x509.publicKey)).toBe(true);
    expect(leaf.x509.checkIssued(pki.intermediate.x509)).toBe(true);
    expect(leaf.x509.subjectAltName).toBe(
      'DNS:localhost, IP Address:127.0.0.1',
    );
  });

  it('honours the validity window and the names it is given', () => {
    const notBefore = new Date('2020-01-01T00:00:00Z');
    const notAfter = new Date('2021-01-01T00:00:00Z');
    const pki = createTestPki();
    const { leaf } = pki.issueServer({
      notBefore,
      notAfter,
      dnsNames: ['a.test', 'b.test'],
      ipAddresses: [],
    });

    expect(leaf.x509.validFromDate.getTime()).toBe(notBefore.getTime());
    expect(leaf.x509.validToDate.getTime()).toBe(notAfter.getTime());
    expect(leaf.x509.subjectAltName).toBe('DNS:a.test, DNS:b.test');
  });

  it('is self-signed when no issuer is given, with a fresh key every time', () => {
    const first = issueCertificate({ commonName: 'one', isCa: true });
    const second = issueCertificate({ commonName: 'one', isCa: true });

    expect(first.x509.verify(first.x509.publicKey)).toBe(true);
    expect(first.fingerprint256).not.toBe(second.fingerprint256);
  });

  it('serves a handshake a client with the root as CA completes', async () => {
    const pki = createTestPki();
    const { leaf, chainPem } = pki.issueServer();
    const server = await startTestTlsServer({
      certPem: chainPem,
      keyPem: leaf.keyPem,
    });
    servers.push(server);

    const authorized = await new Promise<boolean>((resolve, reject) => {
      const socket = tlsConnect(
        {
          host: server.host,
          port: server.port,
          servername: 'localhost',
          ca: [pki.root.pem],
        },
        () => {
          resolve(socket.authorized);
          socket.destroy();
        },
      );
      socket.once('error', reject);
    });

    expect(authorized).toBe(true);
  });
});
