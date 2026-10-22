// The connection form as plain data (M0-52, R3, R4): what the person typed, what the engine's contract takes, and
// the few things the page can say before the engine does. Pure: no Angular, no engine call. The engine stays the
// authority on every rule; this only catches what the contract would refuse (it uses the contract's own schemas)
// so the person is told which field, in words, without a round trip.
//
// Secrets (I-10): a password, a token and a pasted URI are plain strings here because they are being typed. They
// are built into a request at the moment of submit and are never stored anywhere but the form's own state. The
// edit form starts with every secret empty; an empty secret is not sent and so keeps the stored one.
import {
  HostSchema,
  PathPrefixSchema,
  PortSchema,
  UsernameSchema,
  VhostSchema,
  ConnectionNameSchema,
  type ConnectionId,
  type ConnectionProfile,
  type EndpointsInput,
  type EnvClass,
  type InputOf,
  type connectionsCreate,
  type connectionsUpdate,
} from '@app/contracts';

export type HttpAuthKind = 'basic' | 'bearer' | 'none';
export type AmqpAuthKind = 'plain' | 'none';

/** Everything on the form, as typed. Numbers are text until they are checked. */
export interface FormValues {
  readonly name: string;
  readonly envClass: EnvClass;
  /** A pasted `amqp(s)://` URI or management URL, with credentials. Write-only; create only. */
  readonly uri: string;
  readonly http: {
    readonly host: string;
    readonly port: string;
    readonly tls: boolean;
    readonly pathPrefix: string;
    readonly auth: HttpAuthKind;
    readonly username: string;
    /** The password (`basic`) or the token (`bearer`). Write-only. */
    readonly secret: string;
  };
  readonly amqp: {
    readonly host: string;
    readonly port: string;
    readonly tls: boolean;
    readonly vhost: string;
    readonly auth: AmqpAuthKind;
    readonly username: string;
    /** Write-only. */
    readonly secret: string;
  };
  /** Create only: the AMQP login is the management login (the secret is copied at submit, never stored). */
  readonly sameLogin: boolean;
}

/** The name the person gave a field, which the page links an error to. */
export type FieldId =
  | 'name'
  | 'uri'
  | 'http.host'
  | 'http.port'
  | 'http.pathPrefix'
  | 'http.username'
  | 'http.secret'
  | 'amqp.host'
  | 'amqp.port'
  | 'amqp.vhost'
  | 'amqp.username'
  | 'amqp.secret';

/** The wording of an error is a key `connections.form.error.<code>`. */
export type FieldErrorCode =
  | 'required'
  | 'invalid'
  | 'port'
  | 'pathPrefix'
  | 'tooLong'
  | 'secretAgain';

export type FieldErrors = Partial<Record<FieldId, FieldErrorCode>>;

export type FormMode =
  | { readonly kind: 'create' }
  | { readonly kind: 'edit'; readonly profile: ConnectionProfile };

export const ENV_CLASS_CHOICES: readonly EnvClass[] = [
  'dev',
  'local',
  'test',
  'staging',
  'prod',
];

/** The create form: a lab broker is the first use (OQ-791), so the class is `dev` and the logins are shared. */
export function emptyValues(): FormValues {
  return {
    name: '',
    envClass: 'dev',
    uri: '',
    http: {
      host: '',
      port: '',
      tls: false,
      pathPrefix: '',
      auth: 'basic',
      username: '',
      secret: '',
    },
    amqp: {
      host: '',
      port: '',
      tls: false,
      vhost: '',
      auth: 'plain',
      username: '',
      secret: '',
    },
    sameLogin: true,
  };
}

/** The edit form: what is stored, with every secret empty (they read back only as set or not set). */
export function valuesFromProfile(profile: ConnectionProfile): FormValues {
  return {
    name: profile.name,
    envClass: profile.envClass,
    uri: '',
    http: {
      host: profile.http.host,
      port: String(profile.http.port),
      tls: profile.http.tls,
      pathPrefix: profile.http.pathPrefix ?? '',
      auth: profile.http.auth.kind,
      username: profile.http.auth.username ?? '',
      secret: '',
    },
    amqp: {
      host: profile.amqp.host,
      port: String(profile.amqp.port),
      tls: profile.amqp.tls,
      vhost: profile.amqp.vhost,
      auth: profile.amqp.auth.kind,
      username: profile.amqp.auth.username ?? '',
      secret: '',
    },
    sameLogin: false,
  };
}

const text = (value: string): string => value.trim();

function portOf(value: string): number | undefined {
  const t = text(value);
  if (t === '') return undefined;
  return /^\d{1,5}$/.test(t) ? Number(t) : Number.NaN;
}

/** Whether an endpoint's address differs from the stored one: then the stored secret may not follow it (OQ-444). */
export function movedEndpoints(
  values: FormValues,
  profile: ConnectionProfile,
): { readonly http: boolean; readonly amqp: boolean } {
  const differs = (typed: string, stored: string): boolean =>
    text(typed) !== '' && text(typed) !== stored;
  return {
    http:
      differs(values.http.host, profile.http.host) ||
      differs(values.http.port, String(profile.http.port)) ||
      values.http.tls !== profile.http.tls ||
      differs(values.http.pathPrefix, profile.http.pathPrefix ?? ''),
    amqp:
      differs(values.amqp.host, profile.amqp.host) ||
      differs(values.amqp.port, String(profile.amqp.port)) ||
      values.amqp.tls !== profile.amqp.tls,
  };
}

/** The checks the page makes before sending; the engine repeats and extends them. */
export function validate(values: FormValues, mode: FormMode): FieldErrors {
  const errors: Record<string, FieldErrorCode> = {};
  const name = text(values.name);
  if (name === '') errors.name = 'required';
  else if (!ConnectionNameSchema.safeParse(name).success)
    errors.name = 'tooLong';

  const creating = mode.kind === 'create';
  const uri = creating ? text(values.uri) : '';
  const checkHost = (id: FieldId, value: string): void => {
    if (text(value) !== '' && !HostSchema.safeParse(text(value)).success)
      errors[id] = 'invalid';
  };
  const checkPort = (id: FieldId, value: string): void => {
    const port = portOf(value);
    if (port !== undefined && !PortSchema.safeParse(port).success)
      errors[id] = 'port';
  };
  checkHost('http.host', values.http.host);
  checkHost('amqp.host', values.amqp.host);
  checkPort('http.port', values.http.port);
  checkPort('amqp.port', values.amqp.port);
  if (
    text(values.http.pathPrefix) !== '' &&
    !PathPrefixSchema.safeParse(text(values.http.pathPrefix)).success
  )
    errors['http.pathPrefix'] = 'pathPrefix';
  if (
    text(values.amqp.vhost) !== '' &&
    !VhostSchema.safeParse(values.amqp.vhost).success
  )
    errors['amqp.vhost'] = 'invalid';
  for (const [id, value] of [
    ['http.username', values.http.username],
    ['amqp.username', values.amqp.username],
  ] as const) {
    if (text(value) !== '' && !UsernameSchema.safeParse(text(value)).success)
      errors[id] = 'invalid';
  }

  if (creating) {
    // Something to connect to: a URI, or an address for at least one endpoint.
    if (
      uri === '' &&
      text(values.http.host) === '' &&
      text(values.amqp.host) === ''
    )
      errors['http.host'] ??= 'required';
    // Without a URI the logins have to be typed; with one, the URI may carry them.
    if (uri === '') {
      if (values.http.auth !== 'none') {
        if (values.http.auth === 'basic' && text(values.http.username) === '')
          errors['http.username'] ??= 'required';
        if (values.http.secret === '') errors['http.secret'] = 'required';
      }
      const shared = values.sameLogin && values.http.auth === 'basic';
      if (values.amqp.auth !== 'none' && !shared) {
        if (text(values.amqp.username) === '')
          errors['amqp.username'] ??= 'required';
        if (values.amqp.secret === '') errors['amqp.secret'] = 'required';
      }
    }
  } else {
    // A moved address cannot keep the stored secret; the engine refuses it, so the page asks first.
    const moved = movedEndpoints(values, mode.profile);
    const stored = mode.profile;
    if (
      moved.http &&
      stored.http.auth.secret.isSet &&
      values.http.auth === stored.http.auth.kind &&
      values.http.auth !== 'none' &&
      values.http.secret === ''
    )
      errors['http.secret'] = 'secretAgain';
    if (
      moved.amqp &&
      stored.amqp.auth.secret.isSet &&
      values.amqp.auth === stored.amqp.auth.kind &&
      values.amqp.auth !== 'none' &&
      values.amqp.secret === ''
    )
      errors['amqp.secret'] = 'secretAgain';
    // Switching the kind of a login needs the new login.
    if (
      values.http.auth !== stored.http.auth.kind &&
      values.http.auth !== 'none'
    ) {
      if (values.http.auth === 'basic' && text(values.http.username) === '')
        errors['http.username'] ??= 'required';
      if (values.http.secret === '') errors['http.secret'] ??= 'required';
    }
    if (
      values.amqp.auth !== stored.amqp.auth.kind &&
      values.amqp.auth !== 'none'
    ) {
      if (text(values.amqp.username) === '')
        errors['amqp.username'] ??= 'required';
      if (values.amqp.secret === '') errors['amqp.secret'] ??= 'required';
    }
  }
  return errors;
}

type HttpPart = NonNullable<EndpointsInput['http']>;
type AmqpPart = NonNullable<EndpointsInput['amqp']>;

function httpPart(values: FormValues, mode: FormMode): HttpPart | undefined {
  const h = values.http;
  const creating = mode.kind === 'create';
  const withUri = creating && text(values.uri) !== '';
  const part: { -readonly [K in keyof HttpPart]: HttpPart[K] } = {};
  if (text(h.host) !== '') part.host = text(h.host);
  const port = portOf(h.port);
  if (port !== undefined) part.port = port;
  // A checked box is always sent; an unchecked one only when it must switch TLS off (a saved profile), or when
  // nothing else could have set it (no URI): the engine's default is off, so leaving it out is the same.
  if (h.tls || !creating) part.tls = h.tls;
  if (creating ? text(h.pathPrefix) !== '' : true) {
    if (text(h.pathPrefix) !== '') part.pathPrefix = text(h.pathPrefix);
    else if (!creating) part.pathPrefix = null;
  }
  const typedLogin = text(h.username) !== '' || h.secret !== '';
  if (h.auth === 'none') part.auth = { kind: 'none' };
  else if (!withUri || typedLogin || h.auth === 'bearer') {
    part.auth = {
      kind: h.auth,
      ...(h.auth === 'basic' && text(h.username) !== ''
        ? { username: text(h.username) }
        : {}),
      ...(h.secret === ''
        ? {}
        : h.auth === 'bearer'
          ? { token: h.secret }
          : { password: h.secret }),
    };
  }
  return Object.keys(part).length === 0 ? undefined : part;
}

function amqpPart(values: FormValues, mode: FormMode): AmqpPart | undefined {
  const a = values.amqp;
  const creating = mode.kind === 'create';
  const withUri = creating && text(values.uri) !== '';
  const shared =
    creating && values.sameLogin && values.http.auth === 'basic' && !withUri;
  const part: { -readonly [K in keyof AmqpPart]: AmqpPart[K] } = {};
  if (text(a.host) !== '') part.host = text(a.host);
  const port = portOf(a.port);
  if (port !== undefined) part.port = port;
  if (a.tls || !creating) part.tls = a.tls;
  if (text(a.vhost) !== '') part.vhost = a.vhost;
  const username = shared ? text(values.http.username) : text(a.username);
  const secret = shared ? values.http.secret : a.secret;
  if (a.auth === 'none') part.auth = { kind: 'none' };
  else if (!withUri || username !== '' || secret !== '') {
    part.auth = {
      kind: 'plain',
      ...(username === '' ? {} : { username }),
      ...(secret === '' ? {} : { password: secret }),
    };
  }
  return Object.keys(part).length === 0 ? undefined : part;
}

/** The addresses and logins of the form, in the shape both a create and a test of a draft take. */
export function toEndpoints(values: FormValues): EndpointsInput {
  const mode: FormMode = { kind: 'create' };
  const http = httpPart(values, mode);
  const amqp = amqpPart(values, mode);
  const uri = text(values.uri);
  return {
    ...(uri === '' ? {} : { uri }),
    ...(http === undefined ? {} : { http }),
    ...(amqp === undefined ? {} : { amqp }),
  };
}

export function toCreateInput(
  values: FormValues,
): InputOf<typeof connectionsCreate> {
  return {
    name: text(values.name),
    envClass: values.envClass,
    ...toEndpoints(values),
  };
}

export function toUpdateInput(
  cid: ConnectionId,
  values: FormValues,
  profile: ConnectionProfile,
): InputOf<typeof connectionsUpdate> {
  const mode: FormMode = { kind: 'edit', profile };
  const http = httpPart(values, mode);
  const amqp = amqpPart(values, mode);
  return {
    cid,
    name: text(values.name),
    envClass: values.envClass,
    ...(http === undefined ? {} : { http }),
    ...(amqp === undefined ? {} : { amqp }),
  };
}

/** True when anything on the form is a secret that has been typed (for the page to know what to clear). */
export function holdsSecret(values: FormValues): boolean {
  return (
    values.uri !== '' || values.http.secret !== '' || values.amqp.secret !== ''
  );
}
