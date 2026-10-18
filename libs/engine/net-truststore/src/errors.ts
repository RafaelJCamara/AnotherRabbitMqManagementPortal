// Errors of the network layer. net-* projects may not import the kernel (blueprint 2.2), so they
// cannot throw its `AppError`; this class carries the same stable `code` from `@app/contracts`
// and a `detail` that is safe to show. Mapping it to a Problem is the caller's job (OQ-181).
import type { ErrorCode } from '@app/contracts';

/** The Problem codes the network layer raises. */
export type NetworkErrorCode = Extract<
  ErrorCode,
  'VALIDATION_FAILED' | 'EGRESS_DENIED' | 'TLS_UNTRUSTED' | 'BROKER_UNREACHABLE'
>;

/** What a failed handshake can tell the caller without exposing the certificate itself. */
export interface TlsFailure {
  /** The Node/OpenSSL code, for example `CERT_HAS_EXPIRED`. */
  readonly nodeCode: string;
  /** The name the certificate was checked against. */
  readonly verifiedName: string;
}

export interface NetworkErrorOptions {
  readonly cause?: unknown;
  readonly retryable?: boolean;
  readonly tls?: TlsFailure;
}

/**
 * An expected network failure. `detail` never holds key material, a PEM block or a credential;
 * it names hosts, ports and the kind of problem.
 */
export class NetworkError extends Error {
  readonly code: NetworkErrorCode;
  readonly detail: string;
  readonly retryable: boolean;
  readonly tls: TlsFailure | undefined;

  constructor(
    code: NetworkErrorCode,
    detail: string,
    options: NetworkErrorOptions = {},
  ) {
    super(
      `${code}: ${detail}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'NetworkError';
    this.code = code;
    this.detail = detail;
    this.retryable = options.retryable ?? code === 'BROKER_UNREACHABLE';
    this.tls = options.tls;
  }
}
