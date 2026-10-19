// The secret scanner of a bundle (CON-04): "a bundle exported without secrets contains no password,
// token or URI credentials". It uses the kernel's redaction rules, so what the logs would mask is
// what a bundle must not contain: a field whose name says it holds a secret, a URI with a user
// and a password in it, a JWT, a bearer value. It reports where, never what.
//
// The export runs it over its own output as a last check (a leak is an engine fault, not
// something to hand to the person), and the specs run it over exports that were fed canaries.
import { isSensitiveKey, redactText } from '@app/kernel';

const MAX_DEPTH = 16;

/** The paths (`$.profiles[0].http.auth.password`) at which `value` holds something secret-shaped. */
export function findSecretsInBundle(
  value: unknown,
  path = '$',
  depth = 0,
): string[] {
  if (typeof value === 'string') {
    return redactText(value) === value ? [] : [path];
  }
  if (value === null || typeof value !== 'object') return [];
  // Deeper than any bundle is: refuse to vouch for it.
  if (depth >= MAX_DEPTH) return [path];
  if (Array.isArray(value)) {
    return value.flatMap((entry: unknown, index) =>
      findSecretsInBundle(entry, `${path}[${String(index)}]`, depth + 1),
    );
  }
  return Object.entries(value).flatMap(([key, entry]) => {
    const here = `${path}.${key}`;
    // A flag such as `isSet: true` says nothing; a value under a secret-looking name does.
    if (isSensitiveKey(key) && entry !== null && typeof entry !== 'boolean') {
      return [here];
    }
    return findSecretsInBundle(entry, here, depth + 1);
  });
}
