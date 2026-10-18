// Certificate diagnostics: what the UI shows when a TLS connection is untrusted (chain, names,
// expiry, the SNI that was used) and the three `tls` fields a BrokerProfile records.
//
// Everything here reads a handshake that already happened. Nothing here changes whether a
// connection is trusted.
import { X509Certificate } from 'node:crypto';
import { checkServerIdentity, type TLSSocket } from 'node:tls';

import type { BrokerProfile } from '@app/domain-model';

/** Why a certificate was refused, as the UI explains it. */
export type TlsFailureKind =
  | 'untrusted-issuer'
  | 'self-signed'
  | 'hostname-mismatch'
  | 'expired'
  | 'not-yet-valid'
  | 'revoked'
  | 'other-certificate';

const FAILURE_KIND: Readonly<Record<string, TlsFailureKind>> = {
  UNABLE_TO_GET_ISSUER_CERT: 'untrusted-issuer',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'untrusted-issuer',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'untrusted-issuer',
  CERT_UNTRUSTED: 'untrusted-issuer',
  CERT_REJECTED: 'untrusted-issuer',
  SELF_SIGNED_CERT_IN_CHAIN: 'self-signed',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed',
  ERR_TLS_CERT_ALTNAME_INVALID: 'hostname-mismatch',
  CERT_HAS_EXPIRED: 'expired',
  CERT_NOT_YET_VALID: 'not-yet-valid',
  CERT_REVOKED: 'revoked',
  CERT_SIGNATURE_FAILURE: 'other-certificate',
  CERT_CHAIN_TOO_LONG: 'other-certificate',
  INVALID_CA: 'other-certificate',
  INVALID_PURPOSE: 'other-certificate',
  PATH_LENGTH_EXCEEDED: 'other-certificate',
  UNABLE_TO_DECRYPT_CERT_SIGNATURE: 'other-certificate',
  UNABLE_TO_GET_CRL: 'other-certificate',
  ERR_TLS_CERT_ALTNAME_FORMAT: 'other-certificate',
};

/**
 * Maps the code of a failed verification to a kind. `undefined` means the failure is not about
 * the certificate (a reset, a plaintext port, a protocol mismatch).
 */
export function classifyTlsError(
  code: string | undefined,
): TlsFailureKind | undefined {
  return code === undefined ? undefined : FAILURE_KIND[code];
}

export interface CertificateSummary {
  readonly subject: string;
  readonly issuer: string;
  readonly serialNumber: string;
  /** SHA-256, as Node prints it. For display and comparison by a human, not for pinning. */
  readonly fingerprint256: string;
  readonly validFrom: number;
  readonly validTo: number;
  readonly subjectAltNames: readonly string[];
  readonly isCa: boolean;
  readonly selfSigned: boolean;
}

export interface CertDiagnostics {
  /** The certificate chain verified against the trust store (`socket.authorized`). */
  readonly verified: boolean;
  /** Node's verification code when it did not, for example `CERT_HAS_EXPIRED`. */
  readonly authorizationError?: string;
  readonly failure?: TlsFailureKind;
  /** The verification switch was off for this connection. */
  readonly insecureOverride: boolean;
  /** The name the certificate was checked against. */
  readonly verifiedName: string;
  /** The server name sent in the ClientHello; absent for an IP address. */
  readonly sni?: string;
  /** The leaf certificate names the verified name. Independent of the trust chain. */
  readonly sanMatches: boolean;
  readonly protocol?: string;
  readonly cipher?: string;
  /** Leaf first, then the issuers the handshake revealed. */
  readonly chain: readonly CertificateSummary[];
  /** Expiry of the leaf, epoch milliseconds. */
  readonly notAfter?: number;
}

const MAX_CHAIN = 10;

/** `DNS:a.example, IP Address:10.0.0.1` to `['DNS:a.example', 'IP Address:10.0.0.1']`. */
function parseAltNames(value: string | undefined): string[] {
  if (value === undefined || value === '') return [];
  return value
    .split(/,\s*(?=[A-Za-z][A-Za-z ]*:)/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** Summarises one certificate from its DER bytes, so every field comes from one parser. */
export function describeCertificate(certificate: {
  readonly raw: Uint8Array;
}): CertificateSummary {
  const x509 = new X509Certificate(certificate.raw);
  return {
    subject: x509.subject.replaceAll('\n', ', '),
    issuer: x509.issuer.replaceAll('\n', ', '),
    serialNumber: x509.serialNumber,
    fingerprint256: x509.fingerprint256,
    validFrom: x509.validFromDate.getTime(),
    validTo: x509.validToDate.getTime(),
    subjectAltNames: parseAltNames(x509.subjectAltName),
    isCa: x509.ca,
    selfSigned: x509.subject === x509.issuer && x509.verify(x509.publicKey),
  };
}

/** What getPeerCertificate really returns: an empty object when the peer sent nothing. */
interface MaybeCertificate {
  readonly raw?: Uint8Array | undefined;
  readonly issuerCertificate?: MaybeCertificate | undefined;
}

function chainOf(leaf: MaybeCertificate): CertificateSummary[] {
  const chain: CertificateSummary[] = [];
  const seen = new Set<string>();
  let current: MaybeCertificate | undefined = leaf;
  while (current?.raw !== undefined && chain.length < MAX_CHAIN) {
    const summary = describeCertificate({ raw: current.raw });
    if (seen.has(summary.fingerprint256)) break;
    seen.add(summary.fingerprint256);
    chain.push(summary);
    current = current.issuerCertificate;
  }
  return chain;
}

export interface DiagnoseContext {
  readonly verifiedName: string;
  readonly sni?: string;
  readonly insecureOverride: boolean;
}

/** Reads the outcome of a finished handshake. The socket must still be open. */
export function diagnoseTlsSocket(
  socket: TLSSocket,
  context: DiagnoseContext,
): CertDiagnostics {
  const leaf: MaybeCertificate = socket.getPeerCertificate(true);
  const chain = chainOf(leaf);
  const verified = socket.authorized;
  // Node stores the verification code as a string although the typings say Error.
  const reported: unknown = socket.authorizationError;
  const authorizationError = verified
    ? undefined
    : typeof reported === 'string'
      ? reported
      : reported instanceof Error
        ? reported.message
        : 'UNKNOWN';
  const failure = classifyTlsError(authorizationError);
  const protocol = socket.getProtocol();
  const cipher = socket.getCipher() as { name?: string } | null | undefined;
  return {
    verified,
    ...(authorizationError === undefined ? {} : { authorizationError }),
    ...(failure === undefined ? {} : { failure }),
    insecureOverride: context.insecureOverride,
    verifiedName: context.verifiedName,
    ...(context.sni === undefined ? {} : { sni: context.sni }),
    sanMatches:
      leaf.raw !== undefined &&
      checkServerIdentity(
        context.verifiedName,
        socket.getPeerCertificate(false),
      ) === undefined,
    ...(protocol === null ? {} : { protocol }),
    ...(cipher?.name === undefined ? {} : { cipher: cipher.name }),
    chain,
    ...(chain[0] === undefined ? {} : { notAfter: chain[0].validTo }),
  };
}

/** The `tls` member of a BrokerProfile (core-interfaces; `BrokerProfileSchema.shape.tls`). */
export function toProfileTls(
  diagnostics: CertDiagnostics,
): BrokerProfile['tls'] {
  return {
    verified: diagnostics.verified,
    ...(diagnostics.notAfter === undefined
      ? {}
      : { notAfter: diagnostics.notAfter }),
    insecureOverride: diagnostics.insecureOverride,
  };
}
