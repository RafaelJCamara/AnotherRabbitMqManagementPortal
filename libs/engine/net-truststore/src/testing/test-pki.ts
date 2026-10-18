// Test support: a throwaway PKI built in memory, so trust tests need no committed key material
// and no openssl binary. Everything here is for tests of net-truststore and net-dialer
// (`@app/net-truststore/testing`); nothing in the production API imports it.
//
// Certificates are X.509 v3 with ECDSA P-256 keys, encoded by hand (DER) and signed with
// node:crypto. They can be given any validity window (an expired certificate is one argument),
// any subject alternative names, and be CAs or leaves.
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import { createServer, type Server, type TLSSocket } from 'node:tls';

// ---- DER ---------------------------------------------------------------------------------------

const TAG = {
  boolean: 0x01,
  integer: 0x02,
  bitString: 0x03,
  octetString: 0x04,
  oid: 0x06,
  utf8String: 0x0c,
  utcTime: 0x17,
  generalizedTime: 0x18,
  sequence: 0x30,
  set: 0x31,
} as const;

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  if (length < 0x100) return Buffer.from([0x81, length]);
  return Buffer.from([0x82, length >> 8, length & 0xff]);
}

function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const sequence = (...content: Buffer[]): Buffer =>
  tlv(TAG.sequence, ...content);

function oid(dotted: string): Buffer {
  const arcs = dotted.split('.').map(Number);
  const [first = 0, second = 0, ...rest] = arcs;
  const bytes: number[] = [first * 40 + second];
  for (const arc of rest) {
    const groups = [arc & 0x7f];
    for (let value = arc >> 7; value > 0; value >>= 7) {
      groups.unshift((value & 0x7f) | 0x80);
    }
    bytes.push(...groups);
  }
  return tlv(TAG.oid, Buffer.from(bytes));
}

function integer(value: Buffer): Buffer {
  // A positive INTEGER: drop leading zeros, then add one back when the top bit is set.
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  const trimmed = value.subarray(start);
  const needsPad = ((trimmed[0] ?? 0) & 0x80) !== 0;
  return tlv(
    TAG.integer,
    needsPad ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed,
  );
}

const small = (value: number): Buffer => integer(Buffer.from([value]));
const boolTrue = (): Buffer => tlv(TAG.boolean, Buffer.from([0xff]));
const octets = (value: Buffer): Buffer => tlv(TAG.octetString, value);
const bits = (unused: number, value: Buffer): Buffer =>
  tlv(TAG.bitString, Buffer.from([unused]), value);

function time(date: Date): Buffer {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  const year = date.getUTCFullYear();
  const rest =
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z';
  // RFC 5280: UTCTime up to 2049, GeneralizedTime from 2050.
  return year < 2050
    ? tlv(TAG.utcTime, Buffer.from(pad(year % 100) + rest, 'ascii'))
    : tlv(TAG.generalizedTime, Buffer.from(pad(year, 4) + rest, 'ascii'));
}

function name(commonName: string): Buffer {
  return sequence(
    tlv(
      TAG.set,
      sequence(oid('2.5.4.3'), tlv(TAG.utf8String, Buffer.from(commonName))),
    ),
  );
}

function ipBytes(address: string): Buffer {
  if (address.includes(':')) {
    throw new Error('test PKI supports IPv4 addresses only');
  }
  return Buffer.from(address.split('.').map(Number));
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return sequence(oid(id), ...(critical ? [boolTrue()] : []), octets(value));
}

// ---- Certificates ------------------------------------------------------------------------------

/** A certificate with its private key, as PEM, plus the parsed form. */
export interface TestCertificate {
  readonly commonName: string;
  readonly pem: string;
  readonly keyPem: string;
  readonly privateKey: KeyObject;
  readonly x509: X509Certificate;
  /** SHA-256 fingerprint as Node prints it (`AA:BB:...`). */
  readonly fingerprint256: string;
}

export interface IssueOptions {
  readonly commonName: string;
  /** Subject alternative names. A leaf without any is rejected by every verifier. */
  readonly dnsNames?: readonly string[];
  readonly ipAddresses?: readonly string[];
  readonly notBefore?: Date;
  readonly notAfter?: Date;
  /** A CA may sign other certificates. Default false. */
  readonly isCa?: boolean;
  /** The signer. Absent: the certificate signs itself. */
  readonly issuer?: TestCertificate;
}

const DAY_MS = 86_400_000;

/** Issues a certificate. The defaults are valid from yesterday for 30 days. */
export function issueCertificate(options: IssueOptions): TestCertificate {
  const now = Date.now();
  const notBefore = options.notBefore ?? new Date(now - DAY_MS);
  const notAfter = options.notAfter ?? new Date(now + 30 * DAY_MS);
  const isCa = options.isCa ?? false;
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const keyId = createHash('sha1').update(spki).digest();
  const signerKey = options.issuer?.privateKey ?? privateKey;
  const issuerName = name(options.issuer?.commonName ?? options.commonName);

  const extensions = [
    extension('2.5.29.19', true, sequence(...(isCa ? [boolTrue()] : []))),
    extension(
      '2.5.29.15',
      true,
      // CA: keyCertSign and cRLSign; leaf: digitalSignature.
      isCa ? bits(1, Buffer.from([0x06])) : bits(7, Buffer.from([0x80])),
    ),
    extension('2.5.29.14', false, octets(keyId)),
  ];
  const issuerKeyId = options.issuer
    ? createHash('sha1')
        .update(
          createPublicKey(options.issuer.privateKey).export({
            type: 'spki',
            format: 'der',
          }),
        )
        .digest()
    : keyId;
  extensions.push(
    extension('2.5.29.35', false, sequence(tlv(0x80, issuerKeyId))),
  );
  if (!isCa) {
    // serverAuth
    extensions.push(
      extension('2.5.29.37', false, sequence(oid('1.3.6.1.5.5.7.3.1'))),
    );
  }
  const names = [
    ...(options.dnsNames ?? []).map((dns) =>
      tlv(0x82, Buffer.from(dns, 'ascii')),
    ),
    ...(options.ipAddresses ?? []).map((ip) => tlv(0x87, ipBytes(ip))),
  ];
  if (names.length > 0) {
    extensions.push(extension('2.5.29.17', false, sequence(...names)));
  }

  const ecdsaSha256 = sequence(oid('1.2.840.10045.4.3.2'));
  const toBeSigned = sequence(
    tlv(0xa0, small(2)), // version v3
    integer(randomBytes(16)),
    ecdsaSha256,
    issuerName,
    sequence(time(notBefore), time(notAfter)),
    name(options.commonName),
    spki,
    tlv(0xa3, sequence(...extensions)),
  );
  const signature = sign('sha256', toBeSigned, signerKey);
  const der = sequence(toBeSigned, ecdsaSha256, bits(0, signature));
  const pem = `-----BEGIN CERTIFICATE-----\n${(der.toString('base64').match(/.{1,64}/g) ?? []).join('\n')}\n-----END CERTIFICATE-----\n`;
  const x509 = new X509Certificate(pem);
  return {
    commonName: options.commonName,
    pem,
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    privateKey,
    x509,
    fingerprint256: x509.fingerprint256,
  };
}

/** A root CA, an intermediate and a way to issue server certificates under the intermediate. */
export interface TestPki {
  readonly root: TestCertificate;
  readonly intermediate: TestCertificate;
  /** A leaf under the intermediate. The names default to `localhost` and 127.0.0.1. */
  issueServer(options?: Partial<Omit<IssueOptions, 'issuer' | 'isCa'>>): {
    readonly leaf: TestCertificate;
    /** What a server sends: the leaf, then the intermediate (never the root). */
    readonly chainPem: string;
  };
}

export function createTestPki(commonName = 'Test Root CA'): TestPki {
  const root = issueCertificate({ commonName, isCa: true });
  const intermediate = issueCertificate({
    commonName: `${commonName} Intermediate`,
    isCa: true,
    issuer: root,
  });
  return {
    root,
    intermediate,
    issueServer(options = {}) {
      const leaf = issueCertificate({
        commonName: 'test-server',
        dnsNames: ['localhost'],
        ipAddresses: ['127.0.0.1'],
        ...options,
        issuer: intermediate,
      });
      return { leaf, chainPem: leaf.pem + intermediate.pem };
    },
  };
}

// ---- A TLS server ------------------------------------------------------------------------------

export interface TestTlsServer {
  readonly host: '127.0.0.1';
  readonly port: number;
  /** Peers that completed a handshake, in order. */
  readonly accepted: () => number;
  close(): Promise<void>;
}

export interface TestTlsServerOptions {
  /** PEM chain the server sends (leaf first). */
  readonly certPem: string;
  readonly keyPem: string;
  /** Called for every connection that completed the handshake. Default: answer a tiny HTTP reply. */
  readonly onConnection?: (socket: TLSSocket) => void;
}

const HTTP_REPLY =
  'HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok';

/** Starts a TLS server on 127.0.0.1 and a random port. Close it in `afterEach`. */
export async function startTestTlsServer(
  options: TestTlsServerOptions,
): Promise<TestTlsServer> {
  let accepted = 0;
  const sockets = new Set<TLSSocket>();
  const server: Server = createServer(
    { cert: options.certPem, key: options.keyPem },
    (socket) => {
      accepted += 1;
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
      if (options.onConnection) {
        options.onConnection(socket);
        return;
      }
      socket.once('data', () => {
        socket.end(HTTP_REPLY);
      });
    },
  );
  server.on('tlsClientError', () => undefined);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the test TLS server has no TCP address');
  }
  return {
    host: '127.0.0.1',
    port: address.port,
    accepted: () => accepted,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}
