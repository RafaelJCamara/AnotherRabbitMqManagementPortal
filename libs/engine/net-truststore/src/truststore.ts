// TrustStore (DC-44, blueprint 7.5). TLS trust is configured in code, not through NODE_EXTRA_CA_CERTS
// (an Electron app ignores it once the nodeOptions fuse is off):
//
//   defaults        = bundled CAs + system CAs + organisation CAs
//   per-profile CAs = defaults + the profile's own CAs      (concatenated, never replacing)
//   servername      = the name checked against the certificate and sent as SNI
//   insecure        = an explicit switch; the caller must show it (red banner) and record it
//
// There is no leaf pinning: a pinned certificate breaks on every rotation (Amazon MQ rotates).
import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import {
  checkServerIdentity,
  createSecureContext,
  getCACertificates,
  setDefaultCACertificates,
  type PeerCertificate,
  type SecureContext,
} from 'node:tls';

import { NetworkError } from './errors.ts';

/** The two process-wide TLS functions the store uses; tests replace them. */
export interface TlsRuntime {
  getCACertificates(type: 'bundled' | 'system'): string[];
  setDefaultCACertificates(certificates: string[]): void;
}

export const nodeTlsRuntime: TlsRuntime = {
  getCACertificates: (type) => getCACertificates(type),
  setDefaultCACertificates: (certificates) => {
    setDefaultCACertificates(certificates);
  },
};

export interface TrustStoreOptions {
  /** Organisation CAs (PEM, one or more certificates per entry), from the admin configuration. */
  readonly org?: readonly string[];
  /** Read the operating-system store. Default true. */
  readonly includeSystem?: boolean;
  readonly runtime?: TlsRuntime;
}

/** The trust settings of one connection profile. */
export interface TrustProfile {
  /** Extra CAs (PEM). They are added to the defaults, never used instead of them. */
  readonly ca?: readonly string[];
  /** Checked against the certificate and sent as SNI, whatever the host or IP being dialled. */
  readonly servername?: string;
  /** Skip certificate verification. Must be exactly `true`; there is no other spelling. */
  readonly insecure?: boolean;
}

/** What `tls.connect({ socket, ...options })` needs. */
export interface TlsClientOptions {
  readonly secureContext: SecureContext;
  /** SNI. Absent when the name is an IP address (RFC 6066 forbids it). */
  readonly servername?: string;
  readonly rejectUnauthorized: boolean;
  readonly checkServerIdentity: (
    hostname: string,
    certificate: PeerCertificate,
  ) => Error | undefined;
}

export interface TlsTrust {
  /** Defaults followed by the profile's CAs, deduplicated. */
  readonly ca: readonly string[];
  readonly profileCaCount: number;
  /** True only when the profile switched verification off. Record it as `tls.insecureOverride`. */
  readonly insecureOverride: boolean;
  /** The name that will be verified: profile override, then `hint`, then `host`. */
  verifyName(host: string, hint?: string): string;
  /** Options for `tls.connect` over an already connected socket. */
  connectOptions(host: string, hint?: string): TlsClientOptions;
}

export interface TrustSources {
  readonly bundled: number;
  readonly system: number;
  readonly org: number;
  /** Why the system store could not be read, if it could not. */
  readonly systemError?: string;
}

export interface TrustStore {
  /** Bundled, system and organisation CAs, in that order, deduplicated. */
  readonly defaults: readonly string[];
  readonly sources: TrustSources;
  /** Makes `defaults` the process-wide default (`tls.setDefaultCACertificates`). Call at start. */
  install(): void;
  forProfile(profile?: TrustProfile): TlsTrust;
}

const MAX_PEM_BYTES = 1024 * 1024;
const MAX_CERTIFICATES = 256;
const CERTIFICATE_BLOCK =
  /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]*?-----END CERTIFICATE-----/g;
const PRIVATE_KEY_MARKER = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const HOSTNAME =
  /^(?=.{1,253}$)[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?)*$/;

const normalisePem = (block: string): string => `${block.trim()}\n`;

function dedupe(certificates: readonly string[]): string[] {
  return [...new Set(certificates.map((pem) => pem.trim()))].map(normalisePem);
}

/**
 * Splits PEM text into single certificates and checks each one parses. The text may hold
 * several certificates and commentary; it may not hold a private key. Error details name the
 * entry and the problem, never the content (I-10).
 */
export function parseCertificates(pem: string, label: string): string[] {
  if (pem.length > MAX_PEM_BYTES) {
    throw new NetworkError(
      'VALIDATION_FAILED',
      `${label} is larger than ${String(MAX_PEM_BYTES)} bytes`,
    );
  }
  if (PRIVATE_KEY_MARKER.test(pem)) {
    throw new NetworkError(
      'VALIDATION_FAILED',
      `${label} contains private key material; import certificates only`,
    );
  }
  const blocks = pem.match(CERTIFICATE_BLOCK) ?? [];
  if (blocks.length === 0) {
    throw new NetworkError(
      'VALIDATION_FAILED',
      `${label} holds no PEM certificate`,
    );
  }
  if (blocks.length > MAX_CERTIFICATES) {
    throw new NetworkError(
      'VALIDATION_FAILED',
      `${label} holds more than ${String(MAX_CERTIFICATES)} certificates`,
    );
  }
  return blocks.map((block, index) => {
    try {
      new X509Certificate(block);
    } catch (error) {
      throw new NetworkError(
        'VALIDATION_FAILED',
        `certificate ${String(index + 1)} of ${label} is not a valid X.509 certificate`,
        { cause: error },
      );
    }
    return normalisePem(block);
  });
}

/** `[::1]` to `::1`, one trailing dot removed, lower case. */
function normaliseName(raw: string, label: string): string {
  let value = raw.trim();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  if (value.endsWith('.')) value = value.slice(0, -1);
  value = value.toLowerCase();
  if (isIP(value) === 0 && !HOSTNAME.test(value)) {
    throw new NetworkError(
      'VALIDATION_FAILED',
      `${label} is not a valid host name or IP address`,
    );
  }
  return value;
}

/** Validates a server-name override. Returns the normalised name. */
export function validateServername(servername: string): string {
  return normaliseName(servername, 'the server name');
}

function createTlsTrust(
  defaults: readonly string[],
  profile: TrustProfile,
): TlsTrust {
  if (profile.insecure !== undefined && typeof profile.insecure !== 'boolean') {
    throw new NetworkError(
      'VALIDATION_FAILED',
      'insecure must be true or false',
    );
  }
  const profileCas = (profile.ca ?? []).flatMap((entry, index) =>
    parseCertificates(entry, `profile CA ${String(index + 1)}`),
  );
  const override =
    profile.servername === undefined
      ? undefined
      : validateServername(profile.servername);
  const insecure = profile.insecure === true;
  const ca = dedupe([...defaults, ...profileCas]);

  // One secure context per profile: parsing hundreds of CAs on every connection would be slow.
  let context: SecureContext | undefined;
  const secureContext = (): SecureContext => {
    context ??= createSecureContext({ ca, minVersion: 'TLSv1.2' });
    return context;
  };

  const verifyName = (host: string, hint?: string): string =>
    override ??
    (hint === undefined
      ? normaliseName(host, 'the host')
      : normaliseName(hint, 'the server name'));

  return {
    ca,
    profileCaCount: dedupe(profileCas).length,
    insecureOverride: insecure,
    verifyName,
    connectOptions(host, hint) {
      const name = verifyName(host, hint);
      return {
        secureContext: secureContext(),
        ...(isIP(name) === 0 ? { servername: name } : {}),
        rejectUnauthorized: !insecure,
        // Always check the name we mean, not whatever Node would derive from the socket.
        checkServerIdentity: (_hostname, certificate) =>
          checkServerIdentity(name, certificate),
      };
    },
  };
}

/** Builds the trust store. Reads the bundled and system CAs once. */
export function createTrustStore(options: TrustStoreOptions = {}): TrustStore {
  const runtime = options.runtime ?? nodeTlsRuntime;
  const bundled = runtime.getCACertificates('bundled');
  let system: string[] = [];
  let systemError: string | undefined;
  if (options.includeSystem !== false) {
    try {
      system = runtime.getCACertificates('system');
    } catch (error) {
      // Fail closed: without the system store only bundled and organisation CAs are trusted.
      systemError = error instanceof Error ? error.message : String(error);
    }
  }
  const org = (options.org ?? []).flatMap((entry, index) =>
    parseCertificates(entry, `organisation CA ${String(index + 1)}`),
  );
  const defaults = dedupe([...bundled, ...system, ...org]);
  return {
    defaults,
    sources: {
      bundled: bundled.length,
      system: system.length,
      org: org.length,
      ...(systemError === undefined ? {} : { systemError }),
    },
    install() {
      runtime.setDefaultCACertificates([...defaults]);
    },
    forProfile(profile = {}) {
      return createTlsTrust(defaults, profile);
    },
  };
}
