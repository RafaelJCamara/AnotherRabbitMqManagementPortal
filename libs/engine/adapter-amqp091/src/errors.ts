// Errors of the AMQP 0-9-1 adapter. An adapter may not import the kernel (blueprint 2.2), so it
// cannot throw `AppError`; this class carries the stable `code` from `@app/contracts`, a safe
// `detail`, the broker's close frame (class, reply code, text) and an adapter `reason` that names
// the exact refusal. Mapping it to a Problem is the caller's job (OQ-180, OQ-210).
//
// Nothing here ever holds a credential, a URL with credentials, a header value or a message body:
// `detail` is written by this adapter, and the broker's text is shortened and stripped of control
// characters.
import type { ErrorCode } from '@app/contracts';
import { classifyTlsError } from '@app/net-truststore';

/** The Problem codes this adapter raises. */
export type Amqp091ErrorCode = Extract<
  ErrorCode,
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN_BROKER'
  | 'NOT_FOUND'
  | 'BROKER_ERROR'
  | 'BROKER_RESOURCE_LOCKED'
  | 'BROKER_PRECONDITION_FAILED'
  | 'BROKER_UNREACHABLE'
  | 'TLS_UNTRUSTED'
  | 'INTERNAL'
>;

/** Why the adapter refused or failed; stable strings that tests and the executor can match. */
export type Amqp091Reason =
  | 'connect-failed'
  | 'auth-refused'
  | 'tls-untrusted'
  | 'connection-closed'
  | 'channel-closed'
  | 'broker-error'
  | 'timeout'
  | 'aborted'
  /** `get` on a stream (or a queue whose type is not known) is refused before anything is sent. */
  | 'stream-get-refused'
  | 'queue-type-unknown'
  /** A settlement that the lease's role does not allow (a nack that is not requeue=true, ...). */
  | 'forbidden-settle'
  | 'unknown-delivery-tag'
  | 'too-many-held'
  | 'held-deliveries'
  | 'barrier-failed'
  | 'not-own-queue'
  | 'busy'
  | 'released'
  | 'invalid-argument';

/** What the broker said when it closed a channel or the connection. */
export interface BrokerClose {
  readonly protocol: 'amqp091';
  readonly classId?: number;
  readonly methodId?: number;
  readonly code?: number | string;
  readonly text?: string;
}

export interface Amqp091ErrorOptions {
  readonly code?: Amqp091ErrorCode;
  readonly cause?: unknown;
  readonly retryable?: boolean;
  readonly broker?: BrokerClose;
  readonly tls?: { readonly nodeCode: string };
}

const DEFAULT_CODE: Readonly<Record<Amqp091Reason, Amqp091ErrorCode>> = {
  'connect-failed': 'BROKER_UNREACHABLE',
  'auth-refused': 'UNAUTHENTICATED',
  'tls-untrusted': 'TLS_UNTRUSTED',
  'connection-closed': 'BROKER_UNREACHABLE',
  'channel-closed': 'BROKER_ERROR',
  'broker-error': 'BROKER_ERROR',
  timeout: 'BROKER_UNREACHABLE',
  aborted: 'BROKER_UNREACHABLE',
  'stream-get-refused': 'VALIDATION_FAILED',
  'queue-type-unknown': 'VALIDATION_FAILED',
  'forbidden-settle': 'VALIDATION_FAILED',
  'unknown-delivery-tag': 'VALIDATION_FAILED',
  'too-many-held': 'VALIDATION_FAILED',
  'held-deliveries': 'INTERNAL',
  'barrier-failed': 'BROKER_ERROR',
  'not-own-queue': 'VALIDATION_FAILED',
  busy: 'INTERNAL',
  released: 'INTERNAL',
  'invalid-argument': 'VALIDATION_FAILED',
};

const RETRYABLE: ReadonlySet<Amqp091Reason> = new Set([
  'connect-failed',
  'connection-closed',
  'timeout',
]);

export class Amqp091Error extends Error {
  readonly code: Amqp091ErrorCode;
  readonly reason: Amqp091Reason;
  readonly detail: string;
  readonly retryable: boolean;
  readonly broker: BrokerClose | undefined;
  /** The Node/OpenSSL code of a failed certificate check, for the profile's TLS diagnostics. */
  readonly tls: { readonly nodeCode: string } | undefined;

  constructor(
    reason: Amqp091Reason,
    detail: string,
    options: Amqp091ErrorOptions = {},
  ) {
    const code = options.code ?? DEFAULT_CODE[reason];
    super(
      `${code}: ${detail}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'Amqp091Error';
    this.code = code;
    this.reason = reason;
    this.detail = detail;
    this.retryable = options.retryable ?? RETRYABLE.has(reason);
    this.broker = options.broker;
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
  return out;
}

/** AMQP reply codes (spec section 1.2, RabbitMQ extensions) mapped to Problem codes. */
function codeForReply(reply: number): Amqp091ErrorCode {
  switch (reply) {
    case 403:
      return 'FORBIDDEN_BROKER';
    case 404:
      return 'NOT_FOUND';
    case 405:
      return 'BROKER_RESOURCE_LOCKED';
    case 406:
      return 'BROKER_PRECONDITION_FAILED';
    case 320:
    case 541:
      return 'BROKER_UNREACHABLE';
    default:
      return 'BROKER_ERROR';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function stringField(error: Record<string, unknown>, key: string) {
  const value = error[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(error: Record<string, unknown>, key: string) {
  const value = error[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Turns whatever amqplib (or the socket under it) threw into an `Amqp091Error`. An error that is
 * already one is returned as it is.
 */
export function mapAmqplibError(error: unknown, context: string): Amqp091Error {
  if (error instanceof Amqp091Error) return error;
  if (!isRecord(error)) {
    return new Amqp091Error('broker-error', `${context} failed`, {
      cause: error,
    });
  }
  const message = stringField(error, 'message') ?? '';
  const errno = stringField(error, 'code');
  const replyCode = numberField(error, 'code');

  const tlsKind = classifyTlsError(errno);
  if (errno !== undefined && tlsKind !== undefined) {
    return new Amqp091Error(
      'tls-untrusted',
      `${context}: the broker's certificate was refused (${errno})`,
      { cause: error, tls: { nodeCode: errno } },
    );
  }
  // The handshake failure of a refused login has no reply code of its own, only text.
  const handshake = /^Handshake terminated by server: (\d{3})/.exec(message);
  if (handshake?.[1] === '403') {
    return new Amqp091Error(
      'auth-refused',
      `${context}: the broker refused the login`,
      {
        cause: error,
        broker: { protocol: 'amqp091', code: 403, text: safeText(message) },
      },
    );
  }
  if (errno !== undefined && /^E[A-Z]+$/.test(errno)) {
    return new Amqp091Error(
      'connect-failed',
      `${context}: the connection failed (${errno})`,
      { cause: error },
    );
  }
  if (replyCode !== undefined) {
    const classId = numberField(error, 'classId');
    const methodId = numberField(error, 'methodId');
    const closedChannel = /^(Channel closed|Operation failed)/.test(message);
    return new Amqp091Error(
      closedChannel ? 'channel-closed' : 'broker-error',
      `${context}: the broker closed the ${closedChannel ? 'channel' : 'connection'} with ${String(replyCode)}`,
      {
        code: codeForReply(replyCode),
        cause: error,
        retryable: replyCode === 320 || replyCode === 541,
        broker: {
          protocol: 'amqp091',
          code: replyCode,
          text: safeText(message),
          ...(classId === undefined ? {} : { classId }),
          ...(methodId === undefined ? {} : { methodId }),
        },
      },
    );
  }
  if (stringField(error, 'name') === 'IllegalOperationError') {
    return new Amqp091Error(
      'channel-closed',
      `${context}: the channel or connection is already closed`,
      { cause: error },
    );
  }
  if (/Heartbeat timeout|Socket closed|Unexpected close/i.test(message)) {
    return new Amqp091Error(
      'connection-closed',
      `${context}: the connection was lost (${safeText(message, 80)})`,
      { cause: error },
    );
  }
  return new Amqp091Error('broker-error', `${context} failed`, {
    cause: error,
  });
}
