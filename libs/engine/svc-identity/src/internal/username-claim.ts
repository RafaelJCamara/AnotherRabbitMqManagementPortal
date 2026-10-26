// The username assertion (DC-37, OQ-1456): the first token of a connection fixes the user name the
// broker will see, and a refreshed token must carry the same one. A different name would move the
// live connection to another user; a missing name cannot be checked. Both are refused (fail closed).

export type UsernameVerdict = 'same' | 'changed' | 'missing';

/**
 * `expected` is the name of the first token (null when it had none), `refreshed` the name read
 * from the new one. Names are compared exactly: the broker's user names are case-sensitive.
 */
export function checkUsername(
  expected: string | null,
  refreshed: string | null,
): UsernameVerdict {
  if (refreshed === null) return 'missing';
  return refreshed === expected ? 'same' : 'changed';
}
