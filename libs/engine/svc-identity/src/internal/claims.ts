// Reading a token (blueprint 7.5). The broker verifies the signature; this code only reads the
// claims the renewal needs: `exp` and `iat`, and the claim that names the user. It never trusts a
// token for anything else, and it never throws: a token it cannot read gives `undefined`.

/** Past this many characters a token is not read (the broker's own header limit is far lower). */
export const MAX_TOKEN_CHARS = 65_536;

/** The claims the broker may use for the user name, in order (OQ-1456). */
export const DEFAULT_USERNAME_CLAIMS: readonly string[] = ['sub', 'client_id'];

export interface TokenClaims {
  /** `iat` in epoch milliseconds, or null when the token has none. */
  readonly issuedAt: number | null;
  /** `exp` in epoch milliseconds, or null when the token has none. */
  readonly expiresAt: number | null;
  /** The first of the named claims that is a non-empty string, or null. */
  readonly username: string | null;
}

const SEGMENT = /^[A-Za-z0-9_-]+$/;

function decodeObject(segment: string): Record<string, unknown> | undefined {
  if (!SEGMENT.test(segment)) return undefined;
  try {
    const value: unknown = JSON.parse(
      Buffer.from(segment, 'base64url').toString('utf8'),
    );
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** A JWT numeric date (seconds) as epoch milliseconds, or null when it is not a finite number. */
function toMillis(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value * 1000)
    : null;
}

/**
 * The claims of a compact JWT, or `undefined` when `token` is not one: it needs a header and a
 * payload that are base64url JSON objects, and a signature segment (which may be empty).
 */
export function readTokenClaims(
  token: string,
  usernameClaims: readonly string[] = DEFAULT_USERNAME_CLAIMS,
): TokenClaims | undefined {
  if (token.length === 0 || token.length > MAX_TOKEN_CHARS) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const [header, payload, signature] = parts as [string, string, string];
  if (signature !== '' && !SEGMENT.test(signature)) return undefined;
  if (decodeObject(header) === undefined) return undefined;
  const claims = decodeObject(payload);
  if (claims === undefined) return undefined;
  const { iat, exp } = claims as { iat?: unknown; exp?: unknown };
  let username: string | null = null;
  for (const name of usernameClaims) {
    const value = Object.hasOwn(claims, name) ? claims[name] : undefined;
    if (typeof value === 'string' && value.length > 0) {
      username = value;
      break;
    }
  }
  return {
    issuedAt: toMillis(iat),
    expiresAt: toMillis(exp),
    username,
  };
}
