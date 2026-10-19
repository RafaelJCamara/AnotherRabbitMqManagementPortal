// The scrubber of the golden fixtures (M0-25). A fixture is a real broker answer, so before it is
// committed everything that could be a secret or that belongs to the machine that recorded it is
// replaced by a fixed placeholder:
//
//   - the names of the recording host (container id, hostname, container name), which the caller
//     lists with the replacement to use, so a node name keeps its shape (`rabbit@lab-node`);
//   - IPv4 and full-form IPv6 addresses other than loopback and the unspecified address, which
//     become documentation-range addresses (192.0.2.0/24, then 198.51.100.0/24) in the order they
//     are first met;
//   - the value of any key that names a secret (`password_hash`, `token`, `secret`, ...);
//   - secret-shaped strings wherever they are: JWTs, `Bearer` and `Basic` values, credentials in a
//     URL, PEM blocks, the canary secrets of the run;
//   - the home directory of a user (`/home/<name>`, `C:\Users\<name>`).
//
// It is deterministic: the same input and the same host list give the same output, and it never
// reads the clock, the environment or random numbers. Its own spec proves each rule, and
// `findLeaks` is the check the recorder and the fixture specs run over the result.

/** What replaces a scrubbed secret. */
export const SCRUBBED = '<scrubbed>';

/** A secret the recorder plants in the broker (a password, a wrong password) to prove the scrub. */
export const CANARY_SECRET = 'canary-secret-golden-9d41c7';

export interface ScrubOptions {
  /** Literal host-specific text and what replaces it. Longer keys are replaced first. */
  readonly hosts?: Readonly<Record<string, string>>;
  /** Literal secrets that must never survive, besides `CANARY_SECRET`. */
  readonly secrets?: readonly string[];
}

export interface Scrubber {
  /** Scrubs a parsed JSON value (keys and strings); returns a new value. */
  readonly json: (value: unknown) => unknown;
  /** Scrubs free text (a Prometheus page, a plain-text error). */
  readonly text: (text: string) => string;
  /** Scrubs a request path (and leaves its query alone), segment by segment. */
  readonly path: (path: string) => string;
}

const SECRET_KEY =
  /^(?:.*[_-])?(?:password(?:[_-]hash)?|passwd|secret|client[_-]secret|token|access[_-]token|refresh[_-]token|id[_-]token|cookie|erlang[_-]cookie|private[_-]key|api[_-]?key|credentials?|salt|authorization)$/i;

const VERSION_KEY = /version|vsn/i;

// A four-part version (an Erlang/OTP release such as 26.2.5.14) is not an address: the lookbehind
// skips anything written right after a version label, and `json` skips values of `*version*` keys.
const IPV4 =
  /(?<!(?:version|vsn)\W{0,4})(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.]*\d)/gi;
const IPV6_FULL =
  /(?<![0-9a-fA-F:])(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}(?![0-9a-fA-F:])/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g;
const BASIC = /\bBasic\s+[A-Za-z0-9+/=]{8,}/g;
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@"']+:[^/\s@"']+@/gi;
const PEM = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g;
const HOME_POSIX = /\/(?:home|Users)\/(?!user\b)[^/\s"':]+/g;
const HOME_WINDOWS = /([A-Za-z]:\\{1,2}Users\\{1,2})(?!user\b)[^\\\s"':]+/g;

const DOCUMENTATION_PREFIXES = ['192.0.2.', '198.51.100.', '203.0.113.'];

const KEEP_IPV4 = (address: string): boolean => {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => octet > 255)) return true;
  // The documentation ranges are what the scrubber writes: keeping them makes it idempotent.
  return (
    octets[0] === 127 ||
    address === '0.0.0.0' ||
    DOCUMENTATION_PREFIXES.some((prefix) => address.startsWith(prefix))
  );
};

/** `192.0.2.1` to `192.0.2.254`, then `198.51.100.1`... (documentation ranges, RFC 5737). */
function documentationIpv4(index: number): string {
  const block = Math.floor((index - 1) / 254);
  const host = ((index - 1) % 254) + 1;
  const prefixes = ['192.0.2', '198.51.100', '203.0.113'] as const;
  const prefix = prefixes[block];
  if (prefix === undefined) {
    throw new RangeError('more than 762 distinct addresses in one recording');
  }
  return `${prefix}.${String(host)}`;
}

/** `2001:db8::1`, `2001:db8::2`, ... (RFC 3849). */
const documentationIpv6 = (index: number): string =>
  `2001:db8::${index.toString(16)}`;

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createScrubber(options: ScrubOptions = {}): Scrubber {
  const hostEntries = Object.entries(options.hosts ?? {})
    .filter(([literal]) => literal.length >= 3)
    .sort(([a], [b]) => b.length - a.length || a.localeCompare(b));
  const hostPattern =
    hostEntries.length === 0
      ? undefined
      : new RegExp(
          hostEntries.map(([literal]) => escapeRegExp(literal)).join('|'),
          'g',
        );
  const hostReplacement = new Map(hostEntries);
  const secrets = [CANARY_SECRET, ...(options.secrets ?? [])]
    .filter((secret) => secret.length >= 4)
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  const secretPattern = new RegExp(
    secrets.map((secret) => escapeRegExp(secret)).join('|'),
    'g',
  );
  const ipv4 = new Map<string, string>();
  const ipv6 = new Map<string, string>();

  const text = (input: string, addresses = true): string => {
    let out = input;
    out = out.replace(PEM, SCRUBBED);
    out = out.replace(secretPattern, SCRUBBED);
    out = out.replace(JWT, SCRUBBED);
    out = out.replace(BEARER, `Bearer ${SCRUBBED}`);
    out = out.replace(BASIC, `Basic ${SCRUBBED}`);
    out = out.replace(URL_USERINFO, `$1${SCRUBBED}@`);
    if (hostPattern !== undefined) {
      out = out.replace(
        hostPattern,
        (literal) => hostReplacement.get(literal) ?? literal,
      );
    }
    out = out.replace(IPV4, (address) => {
      if (!addresses || KEEP_IPV4(address)) return address;
      let replacement = ipv4.get(address);
      if (replacement === undefined) {
        replacement = documentationIpv4(ipv4.size + 1);
        ipv4.set(address, replacement);
      }
      return replacement;
    });
    out = out.replace(IPV6_FULL, (address) => {
      if (!addresses) return address;
      const key = address.toLowerCase();
      let replacement = ipv6.get(key);
      if (replacement === undefined) {
        replacement = documentationIpv6(ipv6.size + 1);
        ipv6.set(key, replacement);
      }
      return replacement;
    });
    out = out.replace(HOME_POSIX, (match) =>
      match.replace(/\/[^/]+$/, '/user'),
    );
    out = out.replace(HOME_WINDOWS, '$1user');
    return out;
  };

  const json = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string') return text(value, !VERSION_KEY.test(key));
    if (Array.isArray(value)) return value.map((item) => json(item, key));
    if (typeof value === 'object' && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [name, inner] of Object.entries(value)) {
        out[text(name)] =
          SECRET_KEY.test(name) && inner !== null && typeof inner !== 'boolean'
            ? SCRUBBED
            : json(inner, name);
      }
      return out;
    }
    return value;
  };

  // A request path carries a name percent-encoded (`10.0.0.1%3A5000%20-%3E%20...`), where an
  // address is glued to the `%20` before it: decode each segment, scrub, encode it again. A segment
  // that does not change is kept byte for byte, and the query is not touched.
  const path = (input: string): string => {
    const cut = input.indexOf('?');
    const target = cut === -1 ? input : input.slice(0, cut);
    const query = cut === -1 ? '' : input.slice(cut);
    const scrubbed = target
      .split('/')
      .map((segment) => {
        try {
          const decoded = decodeURIComponent(segment);
          const clean = text(decoded);
          return clean === decoded ? segment : encodeURIComponent(clean);
        } catch {
          return segment;
        }
      })
      .join('/');
    return `${scrubbed}${query}`;
  };

  return { json, text, path };
}

const LEAK_PATTERNS: readonly { readonly name: string; readonly re: RegExp }[] =
  [
    {
      name: 'JWT',
      re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/,
    },
    { name: 'PEM block', re: /-----BEGIN [A-Z0-9 ]+-----/ },
    {
      name: 'Bearer value',
      re: /\bBearer\s+(?!<scrubbed>)[A-Za-z0-9._~+/=-]{8,}/,
    },
    { name: 'Basic value', re: /\bBasic\s+(?!<scrubbed>)[A-Za-z0-9+/=]{8,}/ },
    {
      name: 'credentials in a URL',
      re: /\b[a-z][a-z0-9+.-]*:\/\/(?!<scrubbed>@)[^/\s:@"']+:[^/\s@"']+@/i,
    },
    { name: 'canary secret', re: /canary-secret-/i },
  ];

/**
 * What is still in `text` that the scrubber should have removed: the literal secrets given, the
 * canary prefix, and secret-shaped strings. An empty list means clean. Hosts and addresses are not
 * checked here (a lab broker legitimately answers `127.0.0.1`); the scrubber spec covers them.
 */
export function findLeaks(
  text: string,
  secrets: readonly string[] = [],
): string[] {
  const found: string[] = [];
  for (const secret of [CANARY_SECRET, ...secrets]) {
    if (secret.length >= 4 && text.includes(secret)) {
      found.push('a planted secret');
    }
  }
  for (const { name, re } of LEAK_PATTERNS) {
    if (re.test(text)) found.push(name);
  }
  return [...new Set(found)];
}
