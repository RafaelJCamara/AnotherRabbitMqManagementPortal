// Errors of the management HTTP adapter (DC-48, blueprint 3.6). An adapter may not import the
// kernel (blueprint 2.2), so it cannot throw `AppError`; this class carries the stable `code` from
// `@app/contracts`, a safe `detail`, the broker's HTTP answer (`broker`: protocol `http`, the
// status as `code`, its text) and, for a provider restriction, the `gate` that explains it.
// Mapping it to a Problem is the caller's job (OQ-180, OQ-210). The BrokerScheduler reads `code` and
// `broker` to tell overload (429, 5xx) from a refusal.
//
// Nothing here holds a credential, a header value or a URL: `detail` is written by this adapter,
// and the broker's text is shortened and stripped of control characters (I-10).
import type { ErrorCode, GateDecision } from '@app/contracts';
import { NetworkError } from '@app/net-truststore';

/** The Problem codes this adapter raises. */
export type MgmtHttpErrorCode = Extract<
  ErrorCode,
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'TOKEN_EXPIRED'
  | 'FORBIDDEN_BROKER'
  | 'NOT_FOUND'
  | 'CAPABILITY_MISSING'
  | 'RATE_LIMITED'
  | 'BROKER_ERROR'
  | 'BROKER_RESOURCE_LOCKED'
  | 'BROKER_PRECONDITION_FAILED'
  | 'BROKER_UNREACHABLE'
  | 'EGRESS_DENIED'
  | 'TLS_UNTRUSTED'
  | 'INTERNAL'
>;

/** Why the adapter refused or failed; stable strings that tests and the executor can match. */
export type MgmtHttpReason =
  | 'invalid-request'
  | 'bad-request'
  | 'auth-refused'
  | 'missing-tag'
  | 'token-expired'
  | 'forbidden'
  | 'not-found'
  | 'provider-restriction'
  | 'method-not-allowed'
  | 'conflict'
  | 'locked'
  | 'rate-limited'
  | 'unavailable'
  | 'server-error'
  | 'unexpected-status'
  | 'redirect-refused'
  | 'channels-stats-off'
  | 'timeout'
  | 'aborted'
  | 'connect-failed'
  | 'response-too-large'
  | 'unexpected-body'
  | 'network';

export interface MgmtHttpErrorOptions {
  readonly code?: MgmtHttpErrorCode;
  readonly retryable?: boolean;
  /** The HTTP status and the broker's own text, when the broker answered. */
  readonly broker?: { readonly status: number; readonly text?: string };
  readonly gate?: GateDecision;
  readonly tls?: { readonly nodeCode: string; readonly verifiedName: string };
}

const DEFAULT_CODE: Readonly<Record<MgmtHttpReason, MgmtHttpErrorCode>> = {
  'invalid-request': 'VALIDATION_FAILED',
  'bad-request': 'VALIDATION_FAILED',
  'auth-refused': 'UNAUTHENTICATED',
  'missing-tag': 'FORBIDDEN_BROKER',
  'token-expired': 'TOKEN_EXPIRED',
  forbidden: 'FORBIDDEN_BROKER',
  'not-found': 'NOT_FOUND',
  'provider-restriction': 'FORBIDDEN_BROKER',
  'method-not-allowed': 'BROKER_ERROR',
  conflict: 'BROKER_PRECONDITION_FAILED',
  locked: 'BROKER_RESOURCE_LOCKED',
  'rate-limited': 'RATE_LIMITED',
  unavailable: 'BROKER_UNREACHABLE',
  'server-error': 'BROKER_ERROR',
  'unexpected-status': 'BROKER_ERROR',
  'redirect-refused': 'BROKER_ERROR',
  'channels-stats-off': 'CAPABILITY_MISSING',
  timeout: 'BROKER_UNREACHABLE',
  aborted: 'BROKER_UNREACHABLE',
  'connect-failed': 'BROKER_UNREACHABLE',
  'response-too-large': 'BROKER_ERROR',
  'unexpected-body': 'BROKER_ERROR',
  network: 'BROKER_UNREACHABLE',
};

const RETRYABLE: ReadonlySet<MgmtHttpReason> = new Set([
  'rate-limited',
  'unavailable',
  'timeout',
  'connect-failed',
  'network',
]);

export class MgmtHttpError extends Error {
  readonly code: MgmtHttpErrorCode;
  readonly reason: MgmtHttpReason;
  readonly detail: string;
  readonly retryable: boolean;
  /** What the broker answered (HTTP status in `code`), in the shape of `Problem.broker`. */
  readonly broker:
    | {
        readonly protocol: 'http';
        readonly code: number;
        readonly text?: string;
      }
    | undefined;
  /** Set for a provider restriction: the feature is closed on this broker and says why. */
  readonly gate: GateDecision | undefined;
  readonly tls:
    | { readonly nodeCode: string; readonly verifiedName: string }
    | undefined;

  constructor(
    reason: MgmtHttpReason,
    detail: string,
    options: MgmtHttpErrorOptions = {},
  ) {
    const code = options.code ?? DEFAULT_CODE[reason];
    super(`${code}: ${detail}`);
    this.name = 'MgmtHttpError';
    this.code = code;
    this.reason = reason;
    this.detail = detail;
    this.retryable = options.retryable ?? RETRYABLE.has(reason);
    this.broker =
      options.broker === undefined
        ? undefined
        : {
            protocol: 'http',
            code: options.broker.status,
            ...(options.broker.text === undefined
              ? {}
              : { text: options.broker.text }),
          };
    this.gate = options.gate;
    this.tls = options.tls;
  }
}

const MAX_BROKER_TEXT = 300;

/** Makes text from the network safe to show: no control characters, bounded length. */
export function safeText(text: string, max: number = MAX_BROKER_TEXT): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? ' ' : char;
    if (out.length >= max) return `${out.slice(0, max)}...`;
  }
  return out.trim();
}

/**
 * The text of a management error body: `{"error":"bad_request","reason":"..."}` gives the reason,
 * anything else is shown as it is, shortened.
 */
export function brokerText(body: string): string {
  const trimmed = body.trim();
  if (trimmed === '') return '';
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null) {
      const fields = parsed as Record<string, unknown>;
      const reason = fields.reason;
      if (typeof reason === 'string' && reason !== '') return safeText(reason);
      const error = fields.error;
      if (typeof error === 'string' && error !== '') return safeText(error);
    }
  } catch {
    // Not JSON: the proxy or the broker answered with plain text or HTML.
  }
  return safeText(trimmed);
}

/** The answer a provider gives when it switched an operation off (fact sheet, status table). */
const PROVIDER_RESTRICTION = /broker settings disallow/i;
/** `Not management user`, `Not administrator user` ...: the login works, the tag is missing. */
const MISSING_TAG = /^not .* user\b/i;
const TOKEN_EXPIRED = /expired/i;

/**
 * The status-to-code map (DC-48): the one place that decides what a management answer means.
 * `body` is the raw response text; `context` names the operation for the detail.
 */
export function errorForStatus(
  status: number,
  body: string,
  context: string,
): MgmtHttpError {
  const text = brokerText(body);
  const broker = { status, ...(text === '' ? {} : { text }) };
  const said = text === '' ? '' : `: ${text}`;
  const answered = `${context} answered ${String(status)}${said}`;

  if (status === 401) {
    if (TOKEN_EXPIRED.test(text)) {
      return new MgmtHttpError('token-expired', answered, { broker });
    }
    if (MISSING_TAG.test(text)) {
      return new MgmtHttpError('missing-tag', answered, { broker });
    }
    return new MgmtHttpError('auth-refused', answered, { broker });
  }
  if (status === 403) {
    return new MgmtHttpError('forbidden', answered, { broker });
  }
  if (status === 404) {
    return new MgmtHttpError('not-found', answered, { broker });
  }
  if (status === 405) {
    if (PROVIDER_RESTRICTION.test(text)) {
      return new MgmtHttpError('provider-restriction', answered, {
        broker,
        gate: {
          enabled: false,
          reason: text,
          source: 'provider-restriction',
        },
      });
    }
    return new MgmtHttpError('method-not-allowed', answered, { broker });
  }
  if (status === 408 || status === 504) {
    return new MgmtHttpError('timeout', answered, { broker });
  }
  if (status === 409 || status === 412) {
    return new MgmtHttpError('conflict', answered, { broker });
  }
  if (status === 423) {
    return new MgmtHttpError('locked', answered, { broker });
  }
  if (status === 429) {
    return new MgmtHttpError('rate-limited', answered, { broker });
  }
  if (status === 502 || status === 503) {
    return new MgmtHttpError('unavailable', answered, { broker });
  }
  if (status >= 300 && status < 400) {
    // Redirects are never followed: a redirect would leave the host the Dialer approved.
    return new MgmtHttpError('redirect-refused', answered, { broker });
  }
  if (status >= 400 && status < 500) {
    return new MgmtHttpError('bad-request', answered, { broker });
  }
  if (status >= 500) {
    return new MgmtHttpError('server-error', answered, { broker });
  }
  return new MgmtHttpError('unexpected-status', answered, { broker });
}

/** Carries a Dialer or TrustStore failure over, keeping its code (egress, TLS) and nothing else. */
export function errorForNetwork(
  error: unknown,
  context: string,
): MgmtHttpError {
  if (error instanceof MgmtHttpError) return error;
  if (error instanceof NetworkError) {
    return new MgmtHttpError('network', `${context}: ${error.detail}`, {
      code: error.code,
      retryable: error.retryable,
      ...(error.tls === undefined ? {} : { tls: error.tls }),
    });
  }
  const errno =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;
  const suffix = typeof errno === 'string' ? ` (${safeText(errno, 40)})` : '';
  return new MgmtHttpError(
    'network',
    `${context}: the connection failed${suffix}`,
  );
}
