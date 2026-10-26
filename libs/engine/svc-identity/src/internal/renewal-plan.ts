// The pure arithmetic and tables of the TokenManager (CON-07, DC-37, OQ-1458): when a token is
// renewed, how a renewal reaches a live connection, what happens at expiry, and how a failed
// attempt backs off. No clock, no timer, no I/O: the manager passes the times in.
import type { RenewalProtocol } from '@app/ports';

export type RenewalAction =
  | 'update-secret'
  | 'put-auth-token'
  | 'reconnect'
  | 'push-none';

/**
 * How a new token reaches a live connection of `protocol`. HTTP sends the token with each request,
 * so nothing is pushed: the next `credentialFor` returns the new one. A protocol with no way to
 * swap the credential in place reconnects, never "does nothing".
 */
export function renewalActionFor(
  protocol: RenewalProtocol,
  caps: { readonly amqp10TokenRenewalEndpoint: boolean },
): RenewalAction {
  switch (protocol) {
    case 'http':
      return 'push-none';
    case 'amqp091':
      return 'update-secret';
    case 'amqp10':
      return caps.amqp10TokenRenewalEndpoint ? 'put-auth-token' : 'reconnect';
    case 'stream':
      return 'reconnect';
  }
}

export type ExpiryRule = 'cancel-own-consumers' | 'reconnect-on-forced-close';

/**
 * What the engine does when a token runs out. A broker that closes the connection itself leaves
 * the engine to reconnect; one that does not leaves consumers running on an expired credential, so
 * the engine cancels its own. A broker not proven to close takes the second branch.
 */
export function expiryRuleFor(caps: {
  readonly amqp091ClosesAtCredentialExpiry: boolean;
}): ExpiryRule {
  return caps.amqp091ClosesAtCredentialExpiry
    ? 'reconnect-on-forced-close'
    : 'cancel-own-consumers';
}

/** A token is renewed at 3/4 of its lifetime (DC-37). Integer arithmetic: no rounding drift. */
const REFRESH_NUMERATOR = 3;
const REFRESH_DENOMINATOR = 4;

/** The least time between two refreshes, and between two forced-close reconnects (OQ-1458). */
export const MIN_REFRESH_INTERVAL_MS = 5_000;
/** Backoff after a failed attempt: 2 s, doubling to 60 s, at most 8 attempts per lifetime. */
export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_MAX_MS = 60_000;
export const MAX_ATTEMPTS = 8;

/**
 * The instant, in epoch milliseconds, at 75 % of the lifetime `issuedAt` to `expiresAt`. An
 * `issuedAt` in the future (a clock that runs ahead at the issuer) is read as `now`: taken as
 * written it would push the point towards the expiry. A lifetime that is not positive gives a
 * point at or before `issuedAt`, that is, due.
 */
export function refreshPoint(input: {
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly now: number;
}): number {
  const issuedAt = Math.min(input.issuedAt, input.now);
  const lifetime = Math.max(0, input.expiresAt - issuedAt);
  return (
    issuedAt + Math.floor((lifetime * REFRESH_NUMERATOR) / REFRESH_DENOMINATOR)
  );
}

/**
 * When the manager next renews a token it has just taken: the 75 % point, but not sooner than the
 * floor after the last refresh started (a token that is already past its point, or a provider that
 * keeps handing back a stale one, cannot make a tight loop), and never after the expiry.
 */
export function plannedRefreshAt(input: {
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly now: number;
  readonly lastStartedAt: number;
  readonly minIntervalMs?: number;
}): number {
  const floor =
    input.lastStartedAt + (input.minIntervalMs ?? MIN_REFRESH_INTERVAL_MS);
  return Math.min(Math.max(refreshPoint(input), floor), input.expiresAt);
}

/** The wait before attempt number `failures + 1`: 2 s after the first failure, then doubling. */
export function backoffDelayMs(
  failures: number,
  baseMs: number = BACKOFF_BASE_MS,
  maxMs: number = BACKOFF_MAX_MS,
): number {
  const doublings = Math.max(failures - 1, 0);
  return Math.min(baseMs * 2 ** doublings, maxMs);
}
