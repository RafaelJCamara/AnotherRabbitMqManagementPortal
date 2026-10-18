// The TLS handshake over a socket that is already connected (direct today, a tunnel later). This
// is the one place the trust settings of a profile meet `tls.connect`, so the Dialer and every
// test go through the same code.
import type { Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

import {
  classifyTlsError,
  diagnoseTlsSocket,
  type CertDiagnostics,
  type TlsFailureKind,
} from './diagnostics.ts';
import { NetworkError } from './errors.ts';
import type { TlsTrust } from './truststore.ts';

export interface SecureSocketOptions {
  /** Name to verify when the profile has no override (for example undici's servername). */
  readonly hint?: string;
  /** Aborts the handshake. The rejection is the signal's reason. */
  readonly signal?: AbortSignal;
}

export interface SecureResult {
  readonly socket: TLSSocket;
  readonly diagnostics: CertDiagnostics;
}

const FAILURE_TEXT: Readonly<Record<TlsFailureKind, string>> = {
  'untrusted-issuer': 'its issuer is not trusted',
  'self-signed': 'it is self-signed and not in the trust store',
  'hostname-mismatch': 'it does not name the host being verified',
  expired: 'it has expired',
  'not-yet-valid': 'it is not valid yet',
  revoked: 'it was revoked',
  'other-certificate': 'it failed verification',
};

function toNetworkError(
  error: unknown,
  host: string,
  verifiedName: string,
): NetworkError {
  if (error instanceof NetworkError) return error;
  const code =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : undefined;
  const kind = classifyTlsError(code);
  if (kind !== undefined && code !== undefined) {
    return new NetworkError(
      'TLS_UNTRUSTED',
      `the certificate of ${verifiedName} was refused: ${FAILURE_TEXT[kind]} (${code})`,
      { cause: error, retryable: false, tls: { nodeCode: code, verifiedName } },
    );
  }
  // A reset, a plaintext port or a protocol mismatch says nothing about the certificate.
  return new NetworkError(
    'BROKER_UNREACHABLE',
    `the TLS handshake with ${host} failed (${code ?? 'no code'})`,
    { cause: error },
  );
}

/**
 * Runs the handshake and returns the secured socket with its diagnostics.
 *
 * Verification is Node's own (`rejectUnauthorized`) unless the profile switched it off, in which
 * case the result says so (`insecureOverride`) and whether the chain would have verified. If a
 * verifying profile ever produced an unauthorised socket, it is destroyed here as a second line
 * of defence. On failure the underlying socket is destroyed.
 */
export function secureSocket(
  socket: Socket,
  trust: TlsTrust,
  host: string,
  options: SecureSocketOptions = {},
): Promise<SecureResult> {
  const { signal } = options;
  return new Promise<SecureResult>((resolve, reject) => {
    let verifiedName: string;
    let tlsOptions: ReturnType<TlsTrust['connectOptions']>;
    try {
      verifiedName = trust.verifyName(host, options.hint);
      tlsOptions = trust.connectOptions(host, options.hint);
    } catch (error) {
      socket.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (signal?.aborted === true) {
      socket.destroy();
      reject(signal.reason as Error);
      return;
    }
    let secured: TLSSocket;
    try {
      secured = tlsConnect({ socket, ...tlsOptions });
    } catch (error) {
      socket.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const cleanup = (): void => {
      secured.off('secureConnect', onSecure);
      secured.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error): void => {
      cleanup();
      secured.destroy();
      socket.destroy();
      reject(error);
    };
    function onSecure(): void {
      cleanup();
      if (!trust.insecureOverride && !secured.authorized) {
        // Unreachable while rejectUnauthorized is true; kept so a future change cannot hand
        // out an unverified socket silently.
        secured.destroy();
        socket.destroy();
        reject(
          new NetworkError(
            'TLS_UNTRUSTED',
            `the certificate of ${verifiedName} was not verified`,
            { tls: { nodeCode: 'UNVERIFIED', verifiedName } },
          ),
        );
        return;
      }
      resolve({
        socket: secured,
        diagnostics: diagnoseTlsSocket(secured, {
          verifiedName,
          ...(tlsOptions.servername === undefined
            ? {}
            : { sni: tlsOptions.servername }),
          insecureOverride: trust.insecureOverride,
        }),
      });
    }
    function onError(error: Error): void {
      fail(toNetworkError(error, host, verifiedName));
    }
    function onAbort(): void {
      fail(signal?.reason as Error);
    }

    secured.once('secureConnect', onSecure);
    secured.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
