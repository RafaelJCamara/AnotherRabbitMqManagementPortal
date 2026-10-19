// What a profile is made of and how it is derived (CON-01): the stored config of a profile, the
// rules that fill what the person left out from a pasted URI and the broker's defaults, and the
// rules for the secrets that go with it. Pure: it holds no port and never sees a stored secret, only
// whether one is stored.
//
// Secrets are write-only (I-10). `resolveNew` and `resolveChange` return a `SecretChange` per
// protocol: the plain text to seal (`put`), `keep` the stored one, or `remove` it. Nothing here is
// logged or put in an error: the details name fields, never values.
import {
  AmqpAuthKindSchema,
  HostSchema,
  HttpAuthKindSchema,
  PathPrefixSchema,
  PortSchema,
  UsernameSchema,
  VhostSchema,
  type AmqpInputSchema,
  type ConnectionBundle,
  type ConnectionProfile,
  type EndpointsInput,
  type HttpInputSchema,
} from '@app/contracts';
import { AppError } from '@app/kernel';
import type { ConnectionRecord, CredentialRecord } from '@app/ports';
import { z } from 'zod';

import { parseConnectionUri, UriError, type ParsedUri } from './uri';

export const STORED_CONFIG_VERSION = 1;

export const StoredConfigSchema = z.strictObject({
  v: z.literal(STORED_CONFIG_VERSION),
  http: z.strictObject({
    host: HostSchema,
    port: PortSchema,
    tls: z.boolean(),
    pathPrefix: PathPrefixSchema.nullable(),
    auth: z.strictObject({
      kind: HttpAuthKindSchema,
      username: UsernameSchema.nullable(),
    }),
  }),
  amqp: z.strictObject({
    host: HostSchema,
    port: PortSchema,
    tls: z.boolean(),
    vhost: VhostSchema,
    auth: z.strictObject({
      kind: AmqpAuthKindSchema,
      username: UsernameSchema.nullable(),
    }),
  }),
});
export type StoredConfig = z.infer<typeof StoredConfigSchema>;

/** What happens to the secret of one protocol when the profile is saved. */
export type SecretChange = { readonly put: string } | 'keep' | 'remove';

export interface Resolved {
  readonly config: StoredConfig;
  readonly secrets: {
    readonly http: SecretChange;
    readonly amqp: SecretChange;
  };
}

type HttpInput = z.infer<typeof HttpInputSchema>;
type AmqpInput = z.infer<typeof AmqpInputSchema>;

const bad = (detail: string): AppError =>
  new AppError('VALIDATION_FAILED', { detail });

/** The ports RabbitMQ listens on by default: management and AMQP, plain and with TLS. */
const DEFAULT_PORTS = {
  management: { plain: 15672, tls: 15671 },
  amqp: { plain: 5672, tls: 5671 },
  web: { plain: 80, tls: 443 },
} as const;

const pick = (tls: boolean, ports: { plain: number; tls: number }): number =>
  tls ? ports.tls : ports.plain;

export function parseUriInput(text: string): ParsedUri {
  try {
    return parseConnectionUri(text);
  } catch (error) {
    // UriError messages never repeat the input; anything else is not ours to describe.
    throw bad(
      error instanceof UriError ? error.message : 'The URI is not valid.',
    );
  }
}

/** The management API's base URL, without a credential. The default port is left out. */
export function managementUrl(http: StoredConfig['http']): string {
  const host = http.host.includes(':') ? `[${http.host}]` : http.host;
  const port =
    http.port === pick(http.tls, DEFAULT_PORTS.web)
      ? ''
      : `:${String(http.port)}`;
  return `${http.tls ? 'https' : 'http'}://${host}${port}${http.pathPrefix ?? ''}`;
}

interface Source {
  readonly uri: ParsedUri | undefined;
  readonly base: StoredConfig | undefined;
  readonly http: HttpInput | undefined;
  readonly amqp: AmqpInput | undefined;
  /** Whether a secret is stored for each protocol (an update only). */
  readonly stored: { readonly http: boolean; readonly amqp: boolean };
}

interface AuthChoice {
  readonly kind: string;
  readonly username: string | null;
  readonly secret: SecretChange;
}

/**
 * The credential of one protocol. `secretKind` is the kind that takes a secret (`basic` and
 * `bearer` for HTTP, `plain` for AMQP); `given` is what the request sent for it.
 */
function chooseAuth(options: {
  protocol: 'HTTP' | 'AMQP';
  secretKinds: readonly string[];
  given:
    | {
        kind: string;
        username?: string | undefined;
        password?: string | undefined;
        token?: string | undefined;
      }
    | undefined;
  base: { kind: string; username: string | null } | undefined;
  stored: boolean;
  /** The endpoint's address changed, so a stored secret may not follow it (OQ-444). */
  moved: boolean;
  uriLogin: { username: string; password: string | undefined } | undefined;
  /** The kind a URI's credentials make: `basic` for HTTP, `plain` for AMQP. */
  uriKind: string;
}): AuthChoice {
  const { protocol, given } = options;
  if (given === undefined) {
    if (options.base !== undefined) {
      if (options.base.kind === 'none') {
        return { kind: 'none', username: null, secret: 'remove' };
      }
      if (options.moved && options.stored) {
        throw bad(
          `Changing the address of the ${protocol} endpoint needs its secret to be entered again.`,
        );
      }
      return {
        kind: options.base.kind,
        username: options.base.username,
        secret: options.stored ? 'keep' : 'remove',
      };
    }
    if (options.uriLogin === undefined) {
      return { kind: 'none', username: null, secret: 'remove' };
    }
    if (options.uriLogin.password === undefined) {
      throw bad('The URI has a user name but no password.');
    }
    return {
      kind: options.uriKind,
      username: options.uriLogin.username,
      secret: { put: options.uriLogin.password },
    };
  }

  if (given.kind === 'none') {
    if (given.password !== undefined || given.token !== undefined) {
      throw bad(
        `The ${protocol} authentication is none: do not send a secret with it.`,
      );
    }
    return { kind: 'none', username: null, secret: 'remove' };
  }
  if (!options.secretKinds.includes(given.kind)) {
    throw bad(`The ${protocol} authentication kind is not supported.`);
  }
  const bearer = given.kind === 'bearer';
  if (bearer && given.password !== undefined) {
    throw bad('Bearer authentication takes a token, not a password.');
  }
  if (!bearer && given.token !== undefined) {
    throw bad('This authentication takes a password, not a token.');
  }
  const username = bearer
    ? null
    : (given.username ??
      (options.base?.kind === given.kind ? options.base.username : null) ??
      options.uriLogin?.username ??
      null);
  if (!bearer && username === null) {
    throw bad(`The ${protocol} authentication needs a user name.`);
  }
  const sent = bearer ? given.token : given.password;
  if (sent !== undefined)
    return { kind: given.kind, username, secret: { put: sent } };
  const keeps =
    options.base?.kind === given.kind && options.stored && !options.moved;
  if (keeps) return { kind: given.kind, username, secret: 'keep' };
  if (options.uriLogin?.password !== undefined && !bearer) {
    return {
      kind: given.kind,
      username,
      secret: { put: options.uriLogin.password },
    };
  }
  if (options.moved && options.stored && options.base?.kind === given.kind) {
    throw bad(
      `Changing the address of the ${protocol} endpoint needs its secret to be entered again.`,
    );
  }
  throw bad(
    `The ${protocol} authentication needs ${bearer ? 'a token' : 'a password'}.`,
  );
}

function resolve(source: Source): Resolved {
  const { uri, base } = source;
  const inHttp = source.http;
  const inAmqp = source.amqp;

  const httpHost =
    inHttp?.host ??
    base?.http.host ??
    uri?.host ??
    inAmqp?.host ??
    base?.amqp.host;
  if (httpHost === undefined) {
    throw bad('A host is needed: paste a URI, or send http.host or amqp.host.');
  }
  const httpTls = inHttp?.tls ?? base?.http.tls ?? uri?.tls ?? false;
  const httpPort =
    inHttp?.port ??
    base?.http.port ??
    (uri?.kind === 'http'
      ? (uri.port ?? pick(httpTls, DEFAULT_PORTS.web))
      : pick(httpTls, DEFAULT_PORTS.management));
  const pathPrefix =
    inHttp?.pathPrefix !== undefined
      ? inHttp.pathPrefix
      : base !== undefined
        ? base.http.pathPrefix
        : (uri?.pathPrefix ?? null);

  const amqpHost = inAmqp?.host ?? base?.amqp.host ?? uri?.host ?? httpHost;
  const amqpTls = inAmqp?.tls ?? base?.amqp.tls ?? uri?.tls ?? httpTls;
  const amqpPort =
    inAmqp?.port ??
    base?.amqp.port ??
    (uri?.kind === 'amqp' && uri.port !== undefined
      ? uri.port
      : pick(amqpTls, DEFAULT_PORTS.amqp));
  const vhost =
    inAmqp?.vhost ??
    base?.amqp.vhost ??
    (uri?.kind === 'amqp' ? uri.vhost : undefined) ??
    '/';

  const uriLogin =
    uri?.username === undefined
      ? undefined
      : { username: uri.username, password: uri.password };
  const httpMoved =
    base !== undefined &&
    (base.http.host !== httpHost ||
      base.http.port !== httpPort ||
      base.http.tls !== httpTls ||
      base.http.pathPrefix !== pathPrefix);
  const amqpMoved =
    base !== undefined &&
    (base.amqp.host !== amqpHost ||
      base.amqp.port !== amqpPort ||
      base.amqp.tls !== amqpTls);

  const httpAuth = chooseAuth({
    protocol: 'HTTP',
    secretKinds: ['basic', 'bearer'],
    given: inHttp?.auth,
    base: base?.http.auth,
    stored: source.stored.http,
    moved: httpMoved,
    uriLogin,
    uriKind: 'basic',
  });
  const amqpAuth = chooseAuth({
    protocol: 'AMQP',
    secretKinds: ['plain'],
    given: inAmqp?.auth,
    base: base?.amqp.auth,
    stored: source.stored.amqp,
    moved: amqpMoved,
    uriLogin,
    uriKind: 'plain',
  });

  const parsed = StoredConfigSchema.safeParse({
    v: STORED_CONFIG_VERSION,
    http: {
      host: httpHost,
      port: httpPort,
      tls: httpTls,
      pathPrefix,
      auth: { kind: httpAuth.kind, username: httpAuth.username },
    },
    amqp: {
      host: amqpHost,
      port: amqpPort,
      tls: amqpTls,
      vhost,
      auth: { kind: amqpAuth.kind, username: amqpAuth.username },
    },
  });
  if (!parsed.success) {
    // Field paths only: the values may have come from a URI that held a password.
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join('.'))),
    ];
    throw bad(`The profile is not valid: check ${fields.join(', ')}.`);
  }
  return {
    config: parsed.data,
    secrets: { http: httpAuth.secret, amqp: amqpAuth.secret },
  };
}

/** A profile that does not exist yet: addresses from the URI and the fields, defaults for the rest. */
export function resolveNew(input: EndpointsInput): Resolved {
  return resolve({
    uri: input.uri === undefined ? undefined : parseUriInput(input.uri),
    base: undefined,
    http: input.http,
    amqp: input.amqp,
    stored: { http: false, amqp: false },
  });
}

/** A saved profile with changes: what is left out keeps its value and its stored secret. */
export function resolveChange(
  base: StoredConfig,
  stored: { http: boolean; amqp: boolean },
  input: { http?: HttpInput | undefined; amqp?: AmqpInput | undefined },
): Resolved {
  return resolve({
    uri: undefined,
    base,
    http: input.http,
    amqp: input.amqp,
    stored,
  });
}

/** The stored config of a row. A row that does not fit is an engine fault, not the caller's. */
export function configOf(record: ConnectionRecord): StoredConfig {
  const parsed = StoredConfigSchema.safeParse(record.config);
  if (!parsed.success) {
    throw new AppError('INTERNAL', {
      detail: `The stored connection ${record.id} does not fit the profile format.`,
    });
  }
  return parsed.data;
}

const ENV_CLASSES = ['prod', 'staging', 'test', 'dev', 'local'] as const;

/** The profile as a client reads it: no secret, only whether one is set. */
export function toProfile(
  record: ConnectionRecord,
  credentials: readonly CredentialRecord[],
  principalId: string,
): ConnectionProfile {
  const config = configOf(record);
  const status = (protocol: 'http' | 'amqp', kind: string) => {
    const row = credentials.find((entry) => entry.protocol === protocol);
    return kind !== 'none' && row !== undefined
      ? { isSet: true, updatedAt: row.updatedAt }
      : { isSet: false, updatedAt: null };
  };
  const envClass = ENV_CLASSES.find((env) => env === record.envClass);
  if (envClass === undefined) {
    throw new AppError('INTERNAL', {
      detail: `The stored connection ${record.id} has an unknown environment class.`,
    });
  }
  return {
    id: record.id as ConnectionProfile['id'],
    name: record.name,
    envClass,
    color: record.color,
    visibility: record.visibility,
    canEdit: record.ownerId === principalId,
    http: {
      url: managementUrl(config.http),
      host: config.http.host,
      port: config.http.port,
      tls: config.http.tls,
      pathPrefix: config.http.pathPrefix,
      auth: {
        kind: config.http.auth.kind,
        username: config.http.auth.username,
        secret: status('http', config.http.auth.kind),
      },
    },
    amqp: {
      host: config.amqp.host,
      port: config.amqp.port,
      tls: config.amqp.tls,
      vhost: config.amqp.vhost,
      auth: {
        kind: config.amqp.auth.kind,
        username: config.amqp.auth.username,
        secret: status('amqp', config.amqp.auth.kind),
      },
    },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** One profile of a bundle: addresses and user names. Nothing that is a secret is read here. */
export function toBundleProfile(
  record: ConnectionRecord,
): ConnectionBundle['profiles'][number] {
  const config = configOf(record);
  const profile = toProfile(record, [], '');
  return {
    name: profile.name,
    envClass: profile.envClass,
    color: profile.color,
    http: {
      host: config.http.host,
      port: config.http.port,
      tls: config.http.tls,
      pathPrefix: config.http.pathPrefix,
      auth: config.http.auth,
    },
    amqp: {
      host: config.amqp.host,
      port: config.amqp.port,
      tls: config.amqp.tls,
      vhost: config.amqp.vhost,
      auth: config.amqp.auth,
    },
  };
}

/** The stored config of an imported profile: its credentials stay unset, so `auth` keeps its kind. */
export function configOfBundleProfile(
  profile: ConnectionBundle['profiles'][number],
): StoredConfig {
  return {
    v: STORED_CONFIG_VERSION,
    http: { ...profile.http, auth: { ...profile.http.auth } },
    amqp: { ...profile.amqp, auth: { ...profile.amqp.auth } },
  };
}
