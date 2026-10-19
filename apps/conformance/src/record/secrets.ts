// A last gate before an artefact is sealed or written: evidence never holds a secret (I-10).
//
// The recorder keeps secrets out by construction (a step records only the fields its operation
// defines, never a connection string, a header or a message body), and this scan is the second
// line: it fails closed on anything that looks like a credential, and on the values the run knows
// to be secret (the lab login) in the encodings a log line or a URL would carry them.

export interface SecretFinding {
  /** Where in the artefact, for example `steps[2].result.text`. */
  readonly path: string;
  readonly reason: string;
}

const PATTERNS: readonly { reason: string; pattern: RegExp }[] = [
  {
    reason: 'a URL with a user name or password',
    pattern: /:\/\/[^/\s:@]*:[^/\s@]*@/,
  },
  { reason: 'a bearer token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/i },
  {
    reason: 'a basic authorisation header',
    pattern: /\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}/i,
  },
  {
    reason: 'a JSON web token',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/,
  },
  { reason: 'a private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

/** A key that names a credential. Broad on purpose: a false alarm costs a rename, a leak costs more. */
const SECRET_KEY =
  /pass(?:word|wd)|secret|token|authorization|credential|api[-_]?key|private[-_]?key/i;

/** The forms a known secret takes in a URL, in HTTP basic auth and in a hex dump. */
const encodingsOf = (secret: string): string[] => [
  secret,
  encodeURIComponent(secret),
  Buffer.from(secret).toString('base64'),
  Buffer.from(secret).toString('base64url'),
  Buffer.from(secret).toString('hex'),
];

/**
 * Walks a JSON value (keys and strings) and reports every secret-looking thing in it.
 * `known` are values that must not appear at all; the empty string is ignored.
 */
export function findSecrets(
  value: unknown,
  known: readonly string[] = [],
): SecretFinding[] {
  const needles = known
    .filter((secret) => secret !== '')
    .flatMap((secret) => encodingsOf(secret));
  const findings: SecretFinding[] = [];
  const checkText = (text: string, path: string): void => {
    for (const { reason, pattern } of PATTERNS) {
      if (pattern.test(text)) findings.push({ path, reason });
    }
    if (needles.some((needle) => text.includes(needle))) {
      findings.push({ path, reason: 'a value this run knows to be secret' });
    }
  };
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      checkText(node, path);
    } else if (Array.isArray(node)) {
      node.forEach((item, index) => {
        walk(item, `${path}[${String(index)}]`);
      });
    } else if (typeof node === 'object' && node !== null) {
      for (const [key, child] of Object.entries(node)) {
        const here = path === '' ? key : `${path}.${key}`;
        checkText(key, `${here} (key)`);
        if (SECRET_KEY.test(key)) {
          findings.push({
            path: here,
            reason: 'a key that names a credential',
          });
        }
        walk(child, here);
      }
    }
  };
  walk(value, '');
  return findings;
}
