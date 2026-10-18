// What an authenticator sees of a request, and the one comparison every secret goes through.
import { createHash, timingSafeEqual } from 'node:crypto';

import type { Principal } from '@app/ports';

/**
 * The name of the carrier header (blueprint 3.3). The tunnel of M0-34 sets it on injected requests;
 * every network listener refuses a request that carries it. `app` stands for the product name,
 * which stays a placeholder (ADR-029).
 */
export const CARRIER_HEADER = 'x-app-carrier';

export interface AuthInput {
  /** The token of `Authorization: Bearer <token>`; absent when the header is missing or off-form. */
  readonly bearer: string | undefined;
  /** The carrier secret. Only an injected request (never a socket) can present one. */
  readonly carrier: string | undefined;
}

/** Maps credentials to a principal, or to nothing. It never throws for a wrong credential. */
export type Authenticator = (input: AuthInput) => Principal | undefined;

const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]{1,512})$/i;

/** The token of an `Authorization` header, or undefined unless it is exactly `Bearer <token>`. */
export function parseBearer(header: unknown): string | undefined {
  return typeof header === 'string' ? BEARER.exec(header)?.[1] : undefined;
}

/** Constant-time equality of two secrets of any length (both are hashed first). */
export function sameSecret(given: string, expected: string): boolean {
  const digest = (text: string): Buffer =>
    createHash('sha256').update(text, 'utf8').digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/** A secret is at least 32 characters of the base64url alphabet (256 bits when random). */
export function assertSecret(name: string, secret: string): void {
  if (!/^[A-Za-z0-9_-]{32,512}$/.test(secret)) {
    throw new TypeError(
      `${name} must be 32 to 512 characters of A-Za-z0-9_- (256 random bits, base64url).`,
    );
  }
}
