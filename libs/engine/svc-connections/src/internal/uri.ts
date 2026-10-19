// Parsing a pasted connection string (CON-01): an `amqp://` or `amqps://` URI, or the `http(s)://`
// URL of the management API. It uses the WHATWG `URL` class, no package.
//
// What the parser knows (the AMQP 0-9-1 URI specification, as RabbitMQ documents it):
//   - the user and the password are percent-decoded once;
//   - the vhost is the path after the first `/`, percent-decoded once, so the default vhost is
//     `/%2F` and `/prod` is written `/%2Fprod`; a path with a second unescaped `/` is refused;
//   - no path at all, or a lone `/`, is read as the default vhost `/` (OQ-440).
// An error here never repeats the input: it may hold a password (I-10).
export type UriKind = 'amqp' | 'http';

export interface ParsedUri {
  readonly kind: UriKind;
  readonly tls: boolean;
  readonly host: string;
  /** The port written in the URI, when there is one. */
  readonly port?: number;
  /** AMQP only. */
  readonly vhost?: string;
  /** HTTP only: the path in front of `/api`, without a trailing `/`. */
  readonly pathPrefix?: string;
  readonly username?: string;
  readonly password?: string;
}

/** A pasted string that cannot be used. `message` is safe to show: it never contains the input. */
export class UriError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UriError';
  }
}

const SCHEMES: Readonly<
  Record<string, { kind: UriKind; tls: boolean } | undefined>
> = {
  'amqp:': { kind: 'amqp', tls: false },
  'amqps:': { kind: 'amqp', tls: true },
  'http:': { kind: 'http', tls: false },
  'https:': { kind: 'http', tls: true },
};

function decode(part: string, what: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new UriError(`The ${what} in the URI has a broken % escape.`);
  }
}

export function parseConnectionUri(text: string): ParsedUri {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new UriError(
      'The URI is not valid. Use amqp://, amqps:// or the http(s):// URL of the management API.',
    );
  }
  const scheme = SCHEMES[url.protocol];
  if (scheme === undefined) {
    throw new UriError('The URI scheme must be amqp, amqps, http or https.');
  }
  // An IPv6 literal keeps its brackets in `hostname`; the profile stores the bare address.
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (host === '') throw new UriError('The URI has no host.');

  const port = url.port === '' ? undefined : Number(url.port);
  const username =
    url.username === '' ? undefined : decode(url.username, 'user name');
  const password =
    url.password === '' ? undefined : decode(url.password, 'password');
  const common = {
    kind: scheme.kind,
    tls: scheme.tls,
    host,
    ...(port === undefined ? {} : { port }),
    ...(username === undefined ? {} : { username }),
    ...(password === undefined ? {} : { password }),
  };

  if (scheme.kind === 'amqp') {
    const path = url.pathname.replace(/^\//, '');
    if (path.includes('/')) {
      throw new UriError(
        'A vhost that contains a / must be written with %2F, for example amqps://host/%2Fprod.',
      );
    }
    const vhost = path === '' ? '/' : decode(path, 'vhost');
    return { ...common, vhost };
  }

  const prefix = url.pathname.replace(/\/+$/, '');
  return { ...common, ...(prefix === '' ? {} : { pathPrefix: prefix }) };
}
