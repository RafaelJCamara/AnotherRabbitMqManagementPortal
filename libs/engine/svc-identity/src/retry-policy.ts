// The 401 retry rule of DC-37 (OQ-1459), apart from the manager because the HTTP client, not the
// manager, asks it.

/**
 * After a 401 only a read is sent again (DC-37, OQ-1459): GET, HEAD and OPTIONS. A request that
 * mutates, or touches messages, is never repeated on the strength of a refreshed token.
 */
export function isRetryableAfter401(method: string): boolean {
  const upper = method.toUpperCase();
  return upper === 'GET' || upper === 'HEAD' || upper === 'OPTIONS';
}
