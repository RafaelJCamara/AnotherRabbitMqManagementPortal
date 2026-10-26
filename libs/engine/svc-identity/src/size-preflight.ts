// The size preflight (M1-23, DC-38, OQ-1457): a token that is too large for the HTTP header of the
// broker, or for the frame the broker accepts before it knows who is logging in, may fail on first
// use. This module measures the sizes and returns warnings, as keys with numbers, before the
// credential is used. A warning never blocks: the credential is still returned and the broker has
// the last word. Pure, no clock and no I/O; the limits come in as capabilities (I-3), never as a
// version compare here.
//
// The numbers are source readings, not lab results (U-14): the Bearer header threshold is the one
// the issue states, the frame limits are the ones the research notes read from the broker source
// (V41), and `PREAUTH_HEADROOM_BYTES` is a stated estimate (OQ-1457). The texts therefore say a
// request "may" fail.
import type { RenewalProtocol } from '@app/ports';

import type { IssuedCredential } from './provider';

export type SizeWarningCode = 'BEARER_HEADER_LARGE' | 'PLAIN_RESPONSE_LARGE';

export interface SizeWarning {
  readonly code: SizeWarningCode;
  /** `identity.<code>.v1`: English text in `i18n/en/warnings.json`, with {{bytes}} and {{limit}}. */
  readonly textKey: string;
  /** The measured size: the header value, or the PLAIN response (`0x00 user 0x00 token`). */
  readonly bytes: number;
  /** The limit it was measured against. */
  readonly limit: number;
}

/** An HTTP header value above this many bytes gets a warning (the issue's value). */
export const BEARER_HEADER_WARN_BYTES = 4000;
/** The pre-auth frame limit from 4.1.0 (`amqp091PreAuthFrame8192`) and below it (V41). */
export const PREAUTH_FRAME_LIMIT_BYTES = 8192;
export const PREAUTH_FRAME_LIMIT_LEGACY_BYTES = 4096;
/**
 * What the `connection.start-ok` frame holds besides the PLAIN response (client properties, the
 * mechanism name). Not measured: a stated estimate that the lab run of M1-25 replaces (OQ-1457).
 */
export const PREAUTH_HEADROOM_BYTES = 1024;

export interface PreflightInput {
  readonly token: string;
  readonly username: string;
  /** `http` measures a header; every other protocol measures a PLAIN login response. */
  readonly protocol: RenewalProtocol | 'http';
  /** True when the token travels as the password of a Basic header (never chosen for a token). */
  readonly asBasic: boolean;
  readonly caps: { readonly amqp091PreAuthFrame8192: boolean };
}

const utf8 = (text: string): number => Buffer.byteLength(text, 'utf8');
/** The length of the base64 text of `bytes` bytes (padded). */
const base64Length = (bytes: number): number => 4 * Math.ceil(bytes / 3);

const warning = (
  code: SizeWarningCode,
  bytes: number,
  limit: number,
): SizeWarning => ({ code, textKey: `identity.${code}.v1`, bytes, limit });

/**
 * The warnings for sending `token` over `protocol`, none when it fits. The sizes are computed
 * without building the header or the response, so no second copy of the token is made.
 *
 * AMQP 1.0 and stream logins are measured against the smaller frame limit: the registry has a
 * rule for AMQP 0-9-1 only, and the smaller limit is the conservative side.
 */
export function preflightSize(input: PreflightInput): readonly SizeWarning[] {
  const tokenBytes = utf8(input.token);
  const userBytes = utf8(input.username);
  if (input.protocol === 'http') {
    const bytes = input.asBasic
      ? 'Basic '.length + base64Length(userBytes + 1 + tokenBytes)
      : 'Bearer '.length + tokenBytes;
    return bytes > BEARER_HEADER_WARN_BYTES
      ? [warning('BEARER_HEADER_LARGE', bytes, BEARER_HEADER_WARN_BYTES)]
      : [];
  }
  const limit =
    input.protocol === 'amqp091' && input.caps.amqp091PreAuthFrame8192
      ? PREAUTH_FRAME_LIMIT_BYTES
      : PREAUTH_FRAME_LIMIT_LEGACY_BYTES;
  const response = 1 + userBytes + 1 + tokenBytes;
  return response + PREAUTH_HEADROOM_BYTES > limit
    ? [warning('PLAIN_RESPONSE_LARGE', response, limit)]
    : [];
}

/**
 * The value of the HTTP `Authorization` header for a credential (AC-20): a token is always sent
 * as `Bearer`, never as Basic; only a password credential is Basic; the certificate login has no
 * HTTP header. The HTTP client calls this at each request and holds the value no longer than that.
 */
export function httpAuthorization(
  credential: IssuedCredential,
): string | undefined {
  switch (credential.kind) {
    case 'bearer':
      return `Bearer ${credential.token.reveal()}`;
    case 'password':
      return `Basic ${Buffer.from(
        `${credential.username}:${credential.password.reveal()}`,
        'utf8',
      ).toString('base64')}`;
    case 'external':
      return undefined;
  }
}

/**
 * The preflight of an issued credential for the protocol that will carry it. Only a token has a
 * size to warn about; a password or the certificate login gives no warning.
 */
export function preflightCredential(
  credential: IssuedCredential,
  protocol: RenewalProtocol | 'http',
  caps: { readonly amqp091PreAuthFrame8192: boolean },
): readonly SizeWarning[] {
  if (credential.kind !== 'bearer') return [];
  return preflightSize({
    token: credential.token.reveal(),
    username: credential.username ?? '',
    protocol,
    asBasic: false,
    caps,
  });
}
