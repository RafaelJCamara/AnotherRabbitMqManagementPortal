// Redaction policy for logs and error details (I-10, blueprint 13).
//
//   by key:   a field whose name says it holds a secret (authorization, cookie, password, token,
//             secret, ...), any x- header that looks like a credential, and message bodies;
//   by value: credentialed URIs (amqp, amqps, http, https, shovel and federation URIs), query
//             parameters that carry a secret, JWTs (eyJ...) and Bearer values, wherever they
//             appear in a string, including inside an x- header or an error message.
//
// Redaction errs towards removing too much: a secret in a log is a leak, a masked field is a
// nuisance. All patterns are linear (no nested quantifiers), so a hostile log line cannot stall
// the event loop (I-5).

export const REDACTED = '[REDACTED]';

/** Names (lower case, separators removed) that mark a secret value, or a body that is never logged. */
const SENSITIVE_NAME =
  /password|passwd|passphrase|pwd|secret|token|apikey|privatekey|credential|authorization|cookie|sessionid|^body$|^requestbody$|^responsebody$|^rawbody$|^payload$/;
/** An x- header is sensitive when its name also says it is an authentication or key header. */
const SENSITIVE_X_HEADER = /auth|key|jwt|session/;

export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  const name = lower.replace(/[-_.\s]/g, '');
  if (SENSITIVE_NAME.test(name)) return true;
  return lower.startsWith('x-') && SENSITIVE_X_HEADER.test(name);
}

// scheme://userinfo@  ->  scheme://[REDACTED]@   (the user name can be a token too)
const URI_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi;
// ?password=...  /  &token=...  /  ;sig=...
const QUERY_SECRET =
  /([?&;](?:password|passwd|pwd|pass|token|access_token|refresh_token|id_token|secret|client_secret|api_key|apikey|key|sig|signature|sas|auth)=)[^&#\s"']*/gi;
// header.payload[.signature], base64url segments, the first starting with eyJ ({"...)
const JWT = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*){0,3}/g;
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/** Masks credentials wherever they appear in free text. */
export function redactText(text: string): string {
  return text
    .replace(URI_USERINFO, `$1${REDACTED}@`)
    .replace(QUERY_SECRET, `$1${REDACTED}`)
    .replace(JWT, REDACTED)
    .replace(BEARER, `$1 ${REDACTED}`);
}

/** Past this depth a value is dropped rather than inspected. */
const MAX_DEPTH = 32;

/**
 * Redacts a JSON value (what a log line parses to): sensitive keys lose their value at any depth,
 * and every string is scrubbed with `redactText`. Returns a new value; the input is untouched.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) {
    return value.map((entry: unknown) => redactValue(entry, depth + 1));
  }
  // No prototype: a "__proto__" key from the input becomes a plain own property.
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value)) {
    out[key] =
      isSensitiveKey(key) && entry !== null && typeof entry !== 'boolean'
        ? REDACTED
        : redactValue(entry, depth + 1);
  }
  return out;
}

/**
 * Redacts one serialized log line. The line is parsed so that keys are checked and values are
 * scrubbed before they are escaped again; a line that is not JSON is scrubbed as text.
 */
export function redactLine(line: string): string {
  const trimmed = line.endsWith('\n') ? line.slice(0, -1) : line;
  const newline = trimmed.length === line.length ? '' : '\n';
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === 'object') {
      return JSON.stringify(redactValue(parsed)) + newline;
    }
  } catch {
    // Not JSON: fall through to the text rules.
  }
  return redactText(trimmed) + newline;
}
