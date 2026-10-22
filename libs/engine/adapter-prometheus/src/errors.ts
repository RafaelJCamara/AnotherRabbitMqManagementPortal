// Errors of the Prometheus adapter (DC-33, blueprint 3.6). Like the management adapter, it may not
// import the kernel, so it cannot throw `AppError`: this class carries a stable `code` from
// `@app/contracts`, a safe `detail` and, when the endpoint answered, the HTTP status in the shape of
// `Problem.broker`. The BrokerScheduler reads `code` and `broker` to tell overload from refusal, and
// the composition root maps the class to a Problem.
//
// Nothing here holds a credential, a header, a URL or a byte of the body: `detail` is written by this
// adapter (I-10).
import type { ErrorCode } from '@app/contracts';
import { NetworkError } from '@app/net-truststore';

export type PromScrapeErrorCode = Extract<
  ErrorCode,
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN_BROKER'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'BROKER_ERROR'
  | 'BROKER_UNREACHABLE'
  | 'EGRESS_DENIED'
  | 'TLS_UNTRUSTED'
  | 'INTERNAL'
>;

export type PromScrapeReason =
  | 'invalid-request'
  | 'auth-refused'
  | 'forbidden'
  | 'not-found'
  | 'rate-limited'
  | 'unavailable'
  | 'server-error'
  | 'unexpected-status'
  | 'redirect-refused'
  | 'timeout'
  | 'aborted'
  | 'connect-failed'
  | 'response-too-large'
  | 'unexpected-body'
  | 'network';

const DEFAULT_CODE: Readonly<Record<PromScrapeReason, PromScrapeErrorCode>> = {
  'invalid-request': 'VALIDATION_FAILED',
  'auth-refused': 'UNAUTHENTICATED',
  forbidden: 'FORBIDDEN_BROKER',
  'not-found': 'NOT_FOUND',
  'rate-limited': 'RATE_LIMITED',
  unavailable: 'BROKER_UNREACHABLE',
  'server-error': 'BROKER_ERROR',
  'unexpected-status': 'BROKER_ERROR',
  'redirect-refused': 'BROKER_ERROR',
  timeout: 'BROKER_UNREACHABLE',
  aborted: 'BROKER_UNREACHABLE',
  'connect-failed': 'BROKER_UNREACHABLE',
  'response-too-large': 'BROKER_ERROR',
  'unexpected-body': 'BROKER_ERROR',
  network: 'BROKER_UNREACHABLE',
};

const RETRYABLE: ReadonlySet<PromScrapeReason> = new Set([
  'rate-limited',
  'unavailable',
  'timeout',
  'connect-failed',
  'network',
]);

export class PromScrapeError extends Error {
  readonly code: PromScrapeErrorCode;
  readonly reason: PromScrapeReason;
  readonly detail: string;
  readonly retryable: boolean;
  /** The HTTP status the endpoint answered, in the shape of `Problem.broker`. */
  readonly broker:
    | { readonly protocol: 'http'; readonly code: number }
    | undefined;

  constructor(
    reason: PromScrapeReason,
    detail: string,
    options: {
      readonly code?: PromScrapeErrorCode;
      readonly retryable?: boolean;
      readonly status?: number;
    } = {},
  ) {
    const code = options.code ?? DEFAULT_CODE[reason];
    super(`${code}: ${detail}`);
    this.name = 'PromScrapeError';
    this.code = code;
    this.reason = reason;
    this.detail = detail;
    this.retryable = options.retryable ?? RETRYABLE.has(reason);
    this.broker =
      options.status === undefined
        ? undefined
        : { protocol: 'http', code: options.status };
  }
}

/** The status-to-code map of a metrics endpoint. The body is never read into the error. */
export function errorForStatus(
  status: number,
  context: string,
): PromScrapeError {
  const answered = `${context} answered ${String(status)}`;
  const options = { status };
  if (status === 401)
    return new PromScrapeError('auth-refused', answered, options);
  if (status === 403)
    return new PromScrapeError('forbidden', answered, options);
  // The plugin is not enabled, or the path is not served: the planner turns this into the fallback.
  if (status === 404)
    return new PromScrapeError('not-found', answered, options);
  if (status === 408 || status === 504) {
    return new PromScrapeError('timeout', answered, options);
  }
  if (status === 429)
    return new PromScrapeError('rate-limited', answered, options);
  if (status === 502 || status === 503) {
    return new PromScrapeError('unavailable', answered, options);
  }
  // A redirect would leave the host the Dialer approved: never followed.
  if (status >= 300 && status < 400) {
    return new PromScrapeError('redirect-refused', answered, options);
  }
  if (status >= 500)
    return new PromScrapeError('server-error', answered, options);
  return new PromScrapeError('unexpected-status', answered, options);
}

/** Carries a Dialer or TrustStore failure over, keeping its code (egress, TLS) and nothing else. */
export function errorForNetwork(
  error: unknown,
  context: string,
): PromScrapeError {
  if (error instanceof PromScrapeError) return error;
  if (error instanceof NetworkError) {
    return new PromScrapeError('network', `${context}: ${error.detail}`, {
      code: error.code,
      retryable: error.retryable,
    });
  }
  const errno =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;
  const suffix =
    typeof errno === 'string' && /^[A-Z0-9_]{1,40}$/.test(errno)
      ? ` (${errno})`
      : '';
  return new PromScrapeError(
    'network',
    `${context}: the connection failed${suffix}`,
  );
}
