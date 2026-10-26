// Turns a token a provider obtained into a bearer credential, or refuses it. Shared by the providers
// that hand over a token, so the rules are one: the token must be a JWT the broker's oauth2 backend
// can validate (OQ-1456), it must not be expired already (OQ-1458), and the refusal text is fixed.
import { AppError, type Clock } from '@app/kernel';

import type { IssuedCredential } from '../provider';

import { readTokenClaims } from './claims';
import { SecretValue } from './secret-value';

/**
 * The longest a token may live from now. A later expiry (or an `expires_in` that overflows) cannot
 * be trusted to be renewed or to end, so the token is refused rather than used blind.
 */
export const MAX_TOKEN_LIFETIME_MS = 366 * 24 * 60 * 60 * 1000;

export function bearerCredential(input: {
  readonly token: string;
  readonly usernameClaims: readonly string[];
  readonly clock: Clock;
  /** The provider-reported lifetime, used only when the token has no readable `exp` (OQ-1458). */
  readonly expiresInSeconds?: number | null;
  /** True for a token that is never refreshed: without `exp` it would never be renewed or expire. */
  readonly requireExpiry: boolean;
}): Extract<IssuedCredential, { kind: 'bearer' }> {
  const claims = readTokenClaims(input.token, input.usernameClaims);
  if (claims === undefined) {
    throw new AppError('VALIDATION_FAILED', {
      detail:
        'The token cannot be read as a JWT, so its expiry and user name cannot be checked.',
    });
  }
  const now = input.clock.now();
  const reported = input.expiresInSeconds;
  const expiresAt =
    claims.expiresAt ??
    (typeof reported === 'number' && Number.isFinite(reported) && reported > 0
      ? now + Math.round(reported * 1000)
      : null);
  if (expiresAt === null && input.requireExpiry) {
    throw new AppError('VALIDATION_FAILED', {
      detail:
        'The token has no expiry (exp), so it could never be renewed and is refused.',
    });
  }
  if (expiresAt !== null && expiresAt - now > MAX_TOKEN_LIFETIME_MS) {
    throw new AppError('VALIDATION_FAILED', {
      detail:
        'The token expires more than a year from now, so its expiry cannot be trusted and it is refused.',
    });
  }
  if (expiresAt !== null && expiresAt <= now) {
    throw new AppError('TOKEN_EXPIRED', {
      detail: 'The token has already expired.',
    });
  }
  return {
    kind: 'bearer',
    token: new SecretValue(input.token),
    issuedAt: claims.issuedAt ?? now,
    expiresAt,
    username: claims.username,
  };
}
