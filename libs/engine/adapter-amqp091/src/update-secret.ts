// `connection.update-secret` (M1-23, AC-23): what may be sent and how a failure is told.
//
// A renewed token goes to the broker on the open connection. The secret is a bearer token: it is
// checked for size and shape, passed to the driver once and held by nothing here, and a failure is
// described by this file's fixed texts only. The error never carries the library's error as its
// `cause` and never copies the broker's text, because a broker or a library may echo what it was
// sent (I-10). What survives is a reason from a closed list, a Problem code, whether a retry can
// help, and the broker's numeric reply code.
//
// How a refusal arrives (read from amqplib 2.2.0, not yet seen on a lab broker, OQ-1574): the
// broker answers `update-secret-ok` or closes the whole connection (RabbitMQ replies 530
// NOT_ALLOWED when a backend refuses the new secret, and the OAuth 2.0 backend names a user name
// that differs from the login `mismatch_username_after_token_refresh`). amqplib's promise
// settles only on the `-ok` frame, so a refused update never rejects by itself: the connection
// (connect.ts) rejects the pending update when it ends, and the call has its own time limit.
import { Amqp091Error, mapAmqplibError } from './errors.ts';

/** A long string on the wire; the default frame size of a broker is 131,072 bytes. */
export const MAX_SECRET_BYTES = 65_536;
/** The reason is a short string on the wire (at most 255 bytes); the engine's reasons are short. */
const REASON = /^[\x20-\x7e]{1,128}$/;
/** The name the broker's OAuth 2.0 backend gives a renewal for another user. */
const USERNAME_MISMATCH = 'mismatch_username_after_token_refresh';
/** 403 access refused and 530 not allowed: how a broker closes over a secret it refused. */
const REFUSAL_CODES: ReadonlySet<number | string> = new Set([403, 530]);

/** Refuses what is not worth sending. The messages never hold the value. */
export function assertSecretUpdate(secret: unknown, reason: unknown): void {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Amqp091Error('invalid-argument', 'the secret must not be empty');
  }
  if (Buffer.byteLength(secret, 'utf8') > MAX_SECRET_BYTES) {
    throw new Amqp091Error(
      'invalid-argument',
      `the secret must be at most ${String(MAX_SECRET_BYTES)} bytes`,
    );
  }
  if (typeof reason !== 'string' || !REASON.test(reason)) {
    throw new Amqp091Error(
      'invalid-argument',
      'the reason must be 1 to 128 printable ASCII characters',
    );
  }
}

/** The text the library or the broker gave, for matching only; it is never copied anywhere. */
function textOf(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

/**
 * Turns whatever failed an update (a rejection of the driver, the close of the connection, our own
 * time limit) into an `Amqp091Error` with fixed texts. Safe to apply twice.
 */
export function mapSecretUpdateError(error: unknown): Amqp091Error {
  // Already told: its detail came from the broker's text, which is gone now.
  if (error instanceof Amqp091Error && error.reason === 'secret-refused') {
    return error;
  }
  const mapped = mapAmqplibError(error, 'updating the secret');
  const code = mapped.broker?.code;
  const broker =
    code === undefined
      ? {}
      : { broker: { protocol: 'amqp091' as const, code } };
  const mismatch = textOf(error).includes(USERNAME_MISMATCH);
  if (mismatch || (code !== undefined && REFUSAL_CODES.has(code))) {
    return new Amqp091Error(
      'secret-refused',
      mismatch
        ? 'the broker refused the new secret: the user name differs from the login'
        : 'the broker refused the new secret',
      { retryable: false, ...broker },
    );
  }
  return new Amqp091Error(
    mapped.reason,
    `updating the secret failed: ${mapped.reason}`,
    { code: mapped.code, retryable: mapped.retryable, ...broker },
  );
}
