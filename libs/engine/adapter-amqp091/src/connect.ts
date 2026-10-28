// Opening an AMQP 0-9-1 connection and handing out the lease of one role (DC-11/12, ADR-009).
//
// One connection serves exactly one role, and the only thing a caller receives is that role's lease
// (`PeekLease`, `SourceLease`, `PublishLease`, `ObserveLease` of `@app/ports`, or the control
// lease). The amqplib connection and its channels never leave this project, which is how
// "a peek never publishes" and "a publisher never consumes" hold at run time as well as in the
// types.
//
// I-9, how the socket is made. amqplib opens its own socket in `connect()` and offers no way to
// pass it one, so the adapter never lets it reach a host: the Dialer opens the upstream
// connection first (egress policy, one DNS resolution), offers it on a one-client local endpoint
// (a Unix socket, or a named pipe on Windows; `DialerPort.forwarder`), and amqplib is given that
// `path`. `net.connect({ path })` ignores host and port, and the host in the target is a
// documentation address (RFC 5737) that nothing answers, as a second line of defence. TLS is
// amqplib's own handshake over the local endpoint, configured from the TrustStore (`TlsTrust`:
// the profile's CAs added to the defaults, the verified name, the insecure switch). OQ-212.
import type {
  ConnectionRole,
  DialerPort,
  ObserveLease,
  PeekLease,
  PublishLease,
  SourceLease,
} from '@app/ports';
import type { TlsTrust } from '@app/net-truststore';

import { BlockedState } from './blocked.ts';
import {
  TrackedChannel,
  withTimeout,
  type ConnectionEvent,
  type Emit,
} from './channel.ts';
import { amqplibDriver, type Amqp091Driver, type AmqpModel } from './driver.ts';
import { Amqp091Error, mapAmqplibError } from './errors.ts';
import { createControlLease, type ControlLease } from './leases/control.ts';
import { createObserveLease } from './leases/observe.ts';
import { createPeekLease, type PeekLeaseOptions } from './leases/peek.ts';
import { createPublishLease } from './leases/publish.ts';
import { createSourceLease } from './leases/source.ts';
import { assertSecretUpdate, mapSecretUpdateError } from './update-secret.ts';

// ---------------------------------------------------------------------------------------------
// connection_name: <product>/<mode>/<role>/<user-or-session> (blueprint 5.3)
// ---------------------------------------------------------------------------------------------

const ROLES: readonly ConnectionRole[] = [
  'control',
  'peek',
  'source',
  'publish',
  'observe',
];
/** A segment is one token: no `/`, no spaces, no control characters. */
const SEGMENT = /^[A-Za-z0-9<][A-Za-z0-9._:@+=<>-]{0,62}$/;
const MAX_NAME_LENGTH = 200;

export interface ConnectionNameParts {
  /** The product name (the placeholder until ADR-029). */
  readonly product: string;
  /** How the engine runs: `desktop`, `local`, `server`, `cli`, ... */
  readonly mode: string;
  /** The user id (team mode) or a session id. Never a token or a secret (DC-41). */
  readonly session: string;
}

export function formatConnectionName(
  parts: ConnectionNameParts & { readonly role: ConnectionRole },
): string {
  const segments = [parts.product, parts.mode, parts.role, parts.session];
  for (const segment of segments) {
    if (typeof segment !== 'string' || !SEGMENT.test(segment)) {
      throw new Amqp091Error(
        'invalid-argument',
        'a connection name segment must be 1 to 63 characters without "/", spaces or control characters',
      );
    }
  }
  if (!ROLES.includes(parts.role)) {
    throw new Amqp091Error('invalid-argument', 'unknown connection role');
  }
  const name = segments.join('/');
  if (name.length > MAX_NAME_LENGTH) {
    throw new Amqp091Error(
      'invalid-argument',
      'the connection name is too long',
    );
  }
  return name;
}

export function parseConnectionName(
  name: string,
): (ConnectionNameParts & { readonly role: ConnectionRole }) | undefined {
  const segments = name.split('/');
  if (segments.length !== 4) return undefined;
  const [product, mode, role, session] = segments as [
    string,
    string,
    string,
    string,
  ];
  if (!segments.every((segment) => SEGMENT.test(segment))) return undefined;
  if (!(ROLES as readonly string[]).includes(role)) return undefined;
  return { product, mode, role: role as ConnectionRole, session };
}

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

export interface Amqp091Endpoint {
  readonly host: string;
  readonly port: number;
  /** Default `/`. */
  readonly vhost?: string;
  /** Present: `amqps`, verified with this trust. Absent: plain `amqp`. */
  readonly tls?: TlsTrust;
  /** The name to verify and send as SNI when the profile's trust has no override. */
  readonly servername?: string;
}

/** Credentials are used once, to log in, and are not kept (I-10). */
export type Amqp091Credentials =
  | {
      readonly kind: 'plain';
      readonly username: string;
      readonly password: string;
    }
  | { readonly kind: 'external' };

/**
 * Asked at each connect, so a reconnect logs in with what is current (a renewed token) and not
 * with what was current when the options were made (blueprint 7.5, "lazy credentials"). It runs
 * inside the connect budget (`connectTimeoutMs`) and the caller's `signal`. What it throws is not
 * kept: the connect fails with `credentials-unavailable` and no cause.
 */
export type Amqp091CredentialsSource = () =>
  | Amqp091Credentials
  | Promise<Amqp091Credentials>;

export interface ConnectOptions {
  /** The Dialer (I-9). Only `forwarder` is used. */
  readonly dialer: Pick<DialerPort, 'forwarder'>;
  /** The profile's route; its shape belongs to net-dialer. */
  readonly route: unknown;
  readonly endpoint: Amqp091Endpoint;
  /** A value, or a function asked at each connect (see `Amqp091CredentialsSource`). */
  readonly credentials: Amqp091Credentials | Amqp091CredentialsSource;
  readonly name: ConnectionNameParts;
  /** Seconds. Default 30 (blueprint 5.3). */
  readonly heartbeatSeconds?: number;
  /** Handshake budget in milliseconds. Default 10,000. */
  readonly connectTimeoutMs?: number;
  /** The longest a `get`, `qos`, `consume` or passive declare may take. Default 30,000. */
  readonly operationTimeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Replaced by tests and by the second library of the contract suite. */
  readonly driver?: Amqp091Driver;
  readonly now?: () => number;
}

export interface ConnectionInfo {
  readonly connectionName: string;
  readonly role: ConnectionRole;
  readonly heartbeatSeconds: number;
  /** True when the profile switched certificate verification off; record `tls.insecureOverride`. */
  readonly tlsInsecure: boolean;
  /** What the broker calls itself (`version` of its server properties), for display only. */
  readonly serverVersion: string | undefined;
}

export type ConnectionListener = (event: ConnectionEvent) => void;

export interface OpenedLease<L> {
  readonly lease: L;
  readonly info: ConnectionInfo;
  /** Events of the connection (blocked, closed, channel errors, server cancels). */
  readonly subscribe: (listener: ConnectionListener) => () => void;
  /**
   * AMQP 0-9-1 `connection.update-secret`: hands the broker a renewed token on this connection.
   * Resolves when the broker acknowledges it. A refusal (another user, a bad token) is an
   * `Amqp091Error` with reason `secret-refused` and the broker closes the connection. The secret
   * is sent once and kept by nothing; no error carries it. Not part of any lease: the connector
   * offers it to the manager as `OpenedConnection.renew`.
   */
  readonly updateSecret: (secret: string, reason: string) => Promise<void>;
}

const DEFAULT_HEARTBEAT_SECONDS = 30;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const MAX_LISTENERS = 8;
/** Never dialled: `path` is set. In the RFC 5737 documentation range. */
const UNROUTABLE_HOST = '192.0.2.1';
const CLOSE_TIMEOUT_MS = 2_000;

function positiveInt(value: number, name: string, max: number): number {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Amqp091Error(
      'invalid-argument',
      `${name} must be an integer from 1 to ${String(max)}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// The connection (internal: leases receive it, callers never do)
// ---------------------------------------------------------------------------------------------

interface Forwarded {
  close(): Promise<void>;
}

export class Amqp091Connection {
  readonly role: ConnectionRole;
  readonly info: ConnectionInfo;
  readonly blocked: BlockedState;
  readonly operationTimeoutMs: number;
  readonly now: () => number;

  readonly #model: AmqpModel;
  readonly #forwarder: Forwarded;
  readonly #listeners = new Set<ConnectionListener>();
  #ended: Amqp091Error | 'client' | undefined;
  #lastError: Amqp091Error | undefined;
  #closing: Promise<void> | undefined;
  /** Set while an `update-secret` waits for its answer; ends it with the connection's end. */
  #abortUpdate: ((error: Amqp091Error) => void) | undefined;

  constructor(args: {
    role: ConnectionRole;
    info: ConnectionInfo;
    model: AmqpModel;
    forwarder: Forwarded;
    operationTimeoutMs: number;
    now: () => number;
  }) {
    this.role = args.role;
    this.info = Object.freeze(args.info);
    this.operationTimeoutMs = args.operationTimeoutMs;
    this.now = args.now;
    this.blocked = new BlockedState(args.now);
    this.#model = args.model;
    this.#forwarder = args.forwarder;
    // Listeners first: an 'error' event with no listener crashes the process.
    args.model.on('error', (error) => {
      this.#lastError = this.#describe(error);
    });
    args.model.on('close', (error) => {
      if (this.#ended !== undefined) return;
      this.#ended =
        error === undefined && this.#lastError === undefined
          ? new Amqp091Error('connection-closed', 'the connection was closed')
          : (this.#lastError ?? this.#describe(error));
      // The broker's reply code (320 CONNECTION_FORCED when a token ran out, 530 when it refused a
      // secret) lets the manager tell this close from another without reading the error.
      const code = this.#ended.broker?.code;
      this.emit({
        type: 'closed',
        error: this.#ended,
        ...(code === undefined ? {} : { code }),
      });
      this.#abortUpdate?.(this.#ended);
      void this.#forwarder.close().catch(() => undefined);
    });
    args.model.on('blocked', (reason) => {
      this.blocked.block(reason);
      this.emit({
        type: 'blocked',
        reason: this.blocked.snapshot().reason ?? '',
      });
    });
    args.model.on('unblocked', () => {
      this.blocked.unblock();
      this.emit({ type: 'unblocked' });
    });
  }

  /**
   * How a connection error is told. While a secret update waits, the broker may close over the
   * secret and may quote it, so the error is built from fixed text only (update-secret.ts).
   */
  #describe(error: unknown): Amqp091Error {
    return this.#abortUpdate === undefined
      ? mapAmqplibError(error, 'the connection')
      : mapSecretUpdateError(error);
  }

  get isOpen(): boolean {
    return this.#ended === undefined;
  }

  /** Throws why the connection is gone, or `released` when the lease closed it. */
  assertOpen(): void {
    if (this.#ended === 'client') {
      throw new Amqp091Error('released', 'the lease was released');
    }
    if (this.#ended !== undefined) throw this.#ended;
  }

  readonly emit: Emit = (event) => {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // A subscriber must not break the connection it watches.
      }
    }
  };

  subscribe(listener: ConnectionListener): () => void {
    if (this.#listeners.size >= MAX_LISTENERS) {
      throw new Amqp091Error(
        'invalid-argument',
        `at most ${String(MAX_LISTENERS)} subscribers per connection`,
      );
    }
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async openChannel(): Promise<TrackedChannel> {
    this.assertOpen();
    try {
      const raw = await withTimeout(
        this.#model.createChannel(),
        this.operationTimeoutMs,
        'opening a channel',
      );
      return new TrackedChannel(raw, this.emit);
    } catch (error) {
      throw mapAmqplibError(error, 'opening a channel');
    }
  }

  async openConfirmChannel(): Promise<TrackedChannel> {
    this.assertOpen();
    try {
      const raw = await withTimeout(
        this.#model.createConfirmChannel(),
        this.operationTimeoutMs,
        'opening a confirm channel',
      );
      return new TrackedChannel(raw, this.emit);
    } catch (error) {
      throw mapAmqplibError(error, 'opening a confirm channel');
    }
  }

  /**
   * Sends a renewed secret and waits for the broker's `update-secret-ok`. amqplib never settles a
   * refused update (the broker closes the connection instead), so the wait ends with the
   * connection's end, the operation timeout, or the answer, whichever comes first. One update at a
   * time: a second call while one waits is `busy`.
   */
  async updateSecret(secret: string, reason: string): Promise<void> {
    assertSecretUpdate(secret, reason);
    this.assertOpen();
    if (this.#abortUpdate !== undefined) {
      throw new Amqp091Error('busy', 'a secret update is already waiting');
    }
    // The library takes bytes; they are wiped when the call is over (the library copies them into
    // its frame at once, and the text of `secret` is the caller's to drop).
    const bytes = Buffer.from(secret, 'utf8');
    try {
      await new Promise<void>((resolve, reject) => {
        this.#abortUpdate = reject;
        withTimeout(
          this.#model.updateSecret(bytes, reason),
          this.operationTimeoutMs,
          'updating the secret',
        ).then(resolve, reject);
      });
    } catch (error) {
      throw mapSecretUpdateError(error);
    } finally {
      this.#abortUpdate = undefined;
      bytes.fill(0);
    }
  }

  /**
   * Closes the connection. `graceful` runs the AMQP close handshake; `abort` drops the local
   * endpoint at once (and still tries the handshake, best effort). Idempotent.
   */
  close(mode: 'graceful' | 'abort'): Promise<void> {
    this.#closing ??= (async () => {
      // A connection that already ended has told its subscribers; a client close tells them once.
      const alreadyEnded = this.#ended !== undefined;
      this.#ended ??= 'client';
      this.#abortUpdate?.(
        new Amqp091Error('released', 'the lease was released'),
      );
      if (mode === 'abort') {
        await this.#forwarder.close().catch(() => undefined);
      }
      try {
        await withTimeout(
          this.#model.close(),
          mode === 'graceful' ? CLOSE_TIMEOUT_MS : 500,
          'closing the connection',
        );
      } catch {
        // Already closed, or the broker never answered; the endpoint is dropped below.
      }
      await this.#forwarder.close().catch(() => undefined);
      if (!alreadyEnded) this.emit({ type: 'closed' });
    })();
    return this.#closing;
  }
}

// ---------------------------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------------------------

async function openConnection(
  role: ConnectionRole,
  options: ConnectOptions,
): Promise<Amqp091Connection> {
  const driver = options.driver ?? amqplibDriver;
  const now = options.now ?? Date.now;
  const heartbeat = positiveInt(
    options.heartbeatSeconds ?? DEFAULT_HEARTBEAT_SECONDS,
    'heartbeatSeconds',
    600,
  );
  const connectTimeoutMs = positiveInt(
    options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    'connectTimeoutMs',
    120_000,
  );
  const operationTimeoutMs = positiveInt(
    options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
    'operationTimeoutMs',
    600_000,
  );
  const { endpoint } = options;
  const vhost = endpoint.vhost ?? '/';
  if (vhost.length > 255 || /[\u0000-\u001f\u007f]/.test(vhost)) {
    throw new Amqp091Error('invalid-argument', 'the vhost is not valid');
  }
  const connectionName = formatConnectionName({ ...options.name, role });
  const signal = options.signal;
  signal?.throwIfAborted();

  // The Dialer decides whether we may connect and opens the upstream socket, before amqplib exists.
  const forwarder = await options.dialer.forwarder(
    { host: endpoint.host, port: endpoint.port, purpose: 'amqp' },
    options.route,
  );

  let tlsOptions: Record<string, unknown> | undefined;
  let model: AmqpModel;
  try {
    tlsOptions =
      endpoint.tls === undefined
        ? undefined
        : {
            ...endpoint.tls.connectOptions(endpoint.host, endpoint.servername),
          };
    // The credentials are asked for now, as late as possible, and inside the connect budget: a
    // function (a renewed token) may take time, and the caller's signal still ends it.
    const connecting = (async (): Promise<AmqpModel> => {
      const credentials = await resolveCredentials(options.credentials);
      const login =
        credentials.kind === 'external'
          ? driver.external()
          : driver.plain(credentials.username, credentials.password);
      return driver.connect(
        {
          protocol: endpoint.tls === undefined ? 'amqp' : 'amqps',
          hostname: UNROUTABLE_HOST,
          port: 1,
          vhost: encodeURIComponent(vhost),
          heartbeat,
        },
        {
          path: forwarder.path,
          timeout: connectTimeoutMs,
          noDelay: true,
          clientProperties: { connection_name: connectionName },
          credentials: login,
          ...(tlsOptions === undefined ? {} : { tls: tlsOptions }),
        },
      );
    })();
    model = await settleConnect(
      connecting,
      connectTimeoutMs,
      signal,
      forwarder,
    );
  } catch (error) {
    await forwarder.close().catch(() => undefined);
    throw mapAmqplibError(error, 'connecting to the broker');
  }

  const version = model.connection.serverProperties?.version;
  return new Amqp091Connection({
    role,
    info: {
      connectionName,
      role,
      heartbeatSeconds: heartbeat,
      tlsInsecure: endpoint.tls?.insecureOverride ?? false,
      serverVersion: typeof version === 'string' ? version : undefined,
    },
    model,
    forwarder,
    operationTimeoutMs,
    now,
  });
}

/**
 * The login for this connect. A function is called once per connect and what it throws is dropped
 * (it may hold a token); a value that is not a login is refused with a fixed text.
 */
async function resolveCredentials(
  source: Amqp091Credentials | Amqp091CredentialsSource,
): Promise<Amqp091Credentials> {
  let value: unknown;
  try {
    value = typeof source === 'function' ? await source() : source;
  } catch {
    throw new Amqp091Error(
      'credentials-unavailable',
      'the credentials could not be obtained',
    );
  }
  const candidate = value as {
    kind?: unknown;
    username?: unknown;
    password?: unknown;
  } | null;
  if (
    candidate?.kind === 'external' ||
    (candidate?.kind === 'plain' &&
      typeof candidate.username === 'string' &&
      typeof candidate.password === 'string')
  ) {
    return candidate as Amqp091Credentials;
  }
  throw new Amqp091Error(
    'credentials-unavailable',
    'the credentials are not a login',
  );
}

/** Waits for the handshake, the deadline or the caller's signal, whichever comes first. */
async function settleConnect(
  connecting: Promise<AmqpModel>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  forwarder: Forwarded,
): Promise<AmqpModel> {
  let lost = false;
  const abandoned = (): void => {
    lost = true;
    // Dropping the local endpoint fails the handshake in amqplib; nothing may be left running.
    void forwarder.close().catch(() => undefined);
  };
  // A handshake that finishes after we gave up is closed at once.
  const guarded = connecting.then(
    async (model) => {
      if (lost) {
        await model.close().catch(() => undefined);
        throw new Amqp091Error(
          'aborted',
          'the connection attempt was abandoned',
        );
      }
      return model;
    },
    (error: unknown) => {
      throw error;
    },
  );
  guarded.catch(() => undefined);
  let removeAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal === undefined) return;
    const onAbort = (): void => {
      abandoned();
      reject(new Amqp091Error('aborted', 'the connection attempt was aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbort = () => {
      signal.removeEventListener('abort', onAbort);
    };
  });
  aborted.catch(() => undefined);
  try {
    return await Promise.race([
      withTimeout(guarded, timeoutMs + 250, 'the connection handshake').catch(
        (error: unknown) => {
          abandoned();
          throw error;
        },
      ),
      aborted,
    ]);
  } finally {
    removeAbort?.();
  }
}

function opened<L>(connection: Amqp091Connection, lease: L): OpenedLease<L> {
  return {
    lease,
    info: connection.info,
    subscribe: (listener) => connection.subscribe(listener),
    updateSecret: (secret, reason) => connection.updateSecret(secret, reason),
  };
}

/**
 * Closes the connection if building the lease fails, so a rejected `connect*` never leaves a
 * socket behind.
 */
async function withLease<L>(
  role: ConnectionRole,
  options: ConnectOptions,
  build: (connection: Amqp091Connection) => L,
): Promise<OpenedLease<L>> {
  const connection = await openConnection(role, options);
  try {
    return opened(connection, build(connection));
  } catch (error) {
    await connection.close('abort');
    throw error;
  }
}

/** Role `peek`: `get`, `nackRequeue`, `qosBarrier`, `ackWithProof` (rescue only). Never publishes. */
export function connectPeek(
  options: ConnectOptions & PeekLeaseOptions,
): Promise<OpenedLease<PeekLease>> {
  return withLease('peek', options, (c) => createPeekLease(c, options));
}

/** Role `source`: the consumer of a replay or move job. */
export function connectSource(
  options: ConnectOptions,
): Promise<OpenedLease<SourceLease>> {
  return withLease('source', options, (c) => createSourceLease(c));
}

/** Role `publish`: confirm channels, `mandatory` publishes. The only place a copy proof is minted. */
export function connectPublish(
  options: ConnectOptions,
): Promise<OpenedLease<PublishLease>> {
  return withLease('publish', options, (c) => createPublishLease(c));
}

/** Role `observe`: the tap queues of this connection, and nothing else. */
export function connectObserve(
  options: ConnectOptions,
): Promise<OpenedLease<ObserveLease>> {
  return withLease('observe', options, (c) => createObserveLease(c));
}

/** Role `control`: metadata only (passive declares); never holds a message. */
export function connectControl(
  options: ConnectOptions,
): Promise<OpenedLease<ControlLease>> {
  return withLease('control', options, (c) => createControlLease(c));
}
