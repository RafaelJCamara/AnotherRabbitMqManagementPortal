// The Dialer (I-9, DC-43): the one place an outbound socket is opened. This work item covers the
// direct route, with and without TLS. SSH, SOCKS5 and HTTP CONNECT routes arrive with M1-22 and
// plug into `openTransport`; the policy check before it, and the TLS handshake after it, stay.
//
// `Dialer` extends `DialerPort` (M0-23): the port's three methods, plus `dial` and a `tls` member
// on the target, which the port does not know about yet (OQ-181).
import { createConnection, isIP, type Socket } from 'node:net';

import type {
  DialCheck,
  DialerPort,
  DialTarget as PortDialTarget,
} from '@app/ports';
import {
  NetworkError,
  secureSocket,
  type CertDiagnostics,
  type TlsTrust,
} from '@app/net-truststore';

import { openForwarder, type Forwarder } from './forwarder.ts';
import {
  allowAllPolicy,
  approvedLookup,
  egressDenied,
  evaluatePolicy,
  resolveHost,
  systemResolver,
  type EgressPolicy,
  type ResolvedAddress,
  type Resolver,
} from './policy-hook.ts';

/** The only route this work item implements. */
export interface DirectRoute {
  readonly kind: 'direct';
}

/** What check and orwarder take: the port's target (host, port, purpose). */
export type CheckTarget = PortDialTarget;

export type CheckResult = DialCheck;

export interface DialTarget extends CheckTarget {
  /** Name to verify and send as SNI when the profile has no override. */
  readonly servername?: string;
  /** TLS trust of the profile. Absent: a plain TCP socket. */
  readonly tls?: TlsTrust;
}

export interface DialResult {
  /** A TLSSocket when the target had `tls`. */
  readonly socket: Socket;
  /** The handshake outcome; record `toProfileTls(tls)` on the BrokerProfile. */
  readonly tls?: CertDiagnostics;
}

export interface Dialer extends DialerPort {
  check(target: CheckTarget): Promise<CheckResult>;
  connect(
    target: DialTarget,
    route: unknown,
    signal?: AbortSignal,
  ): Promise<Socket>;
  /** Like `connect`, and also returns what the TLS handshake found. */
  dial(
    target: DialTarget,
    route: unknown,
    signal?: AbortSignal,
  ): Promise<DialResult>;
  /** A one-client local endpoint wired to the target (plain bytes; no `tls` on the target). */
  forwarder(
    target: CheckTarget,
    route: unknown,
    signal?: AbortSignal,
  ): Promise<Forwarder>;
}

/** The part of a logger the Dialer uses (a kernel `Logger` fits). */
export interface DialerLog {
  warn(fields: Record<string, unknown>, message?: string): void;
}

export interface DialerOptions {
  /** Default: allow everything (the SSRF policy comes with M3-09). */
  readonly policy?: EgressPolicy;
  readonly resolver?: Resolver;
  /** Resolution, TCP connect and TLS handshake together. Default 10 seconds. */
  readonly connectTimeoutMs?: number;
  readonly log?: DialerLog;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const PURPOSE = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;
const HOST_FORBIDDEN = /[\s/\\@#?]/;

function invalid(detail: string): NetworkError {
  return new NetworkError('VALIDATION_FAILED', detail);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 0x20) return true;
  }
  return false;
}

function validateTarget(target: CheckTarget): {
  host: string;
  port: number;
  purpose: string;
} {
  let host = target.host.trim();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (
    host === '' ||
    host.length > 253 ||
    HOST_FORBIDDEN.test(host) ||
    hasControlCharacter(host) ||
    (host.includes(':') && isIP(host) === 0)
  ) {
    throw invalid('the host is empty or contains characters a host cannot');
  }
  if (
    !Number.isInteger(target.port) ||
    target.port < 1 ||
    target.port > 65535
  ) {
    throw invalid('the port must be an integer from 1 to 65535');
  }
  if (!PURPOSE.test(target.purpose)) {
    throw invalid('the purpose must be a short identifier such as mgmt-http');
  }
  return { host, port: target.port, purpose: target.purpose };
}

function requireDirect(route: unknown): void {
  const kind =
    typeof route === 'object' && route !== null && 'kind' in route
      ? route.kind
      : undefined;
  if (kind !== 'direct') {
    throw invalid(
      `route ${typeof kind === 'string' ? `"${kind}"` : '(none)'} is not available: only "direct" exists until M1-22`,
    );
  }
}

/** Rejects with the signal's reason as soon as it aborts, whatever promise is still doing. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason as Error);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

const errnoOf = (error: unknown): string =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof error.code === 'string'
    ? error.code
    : 'unknown error';

export function createDialer(options: DialerOptions = {}): Dialer {
  const policy = options.policy ?? allowAllPolicy;
  const resolver = options.resolver ?? systemResolver;
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  /** Resolves once and asks the policy about every address. Throws if any request is refused. */
  async function approve(
    host: string,
    port: number,
    purpose: string,
  ): Promise<readonly ResolvedAddress[]> {
    let addresses: readonly ResolvedAddress[];
    try {
      addresses = await resolveHost(host, resolver);
    } catch (error) {
      throw new NetworkError(
        'BROKER_UNREACHABLE',
        `cannot resolve ${host} (${errnoOf(error)})`,
        { cause: error },
      );
    }
    if (addresses.length === 0) {
      throw new NetworkError(
        'BROKER_UNREACHABLE',
        `${host} resolved to no address`,
      );
    }
    const decision = await evaluatePolicy(policy, {
      host,
      port,
      purpose,
      addresses: addresses.map((entry) => entry.address),
    }).catch(() => ({
      allowed: false as const,
      reason: 'the egress policy failed, so the connection is refused',
    }));
    if (!decision.allowed) throw egressDenied(host, port, decision.reason);
    return addresses;
  }

  /** Opens the TCP connection to exactly the approved addresses. */
  function openTransport(
    host: string,
    port: number,
    approved: readonly ResolvedAddress[],
    signal: AbortSignal,
  ): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const socket = createConnection({
        host,
        port,
        // An IP literal skips the lookup, which is why `approve` already checked it.
        lookup: approvedLookup(host, approved),
        noDelay: true,
      });
      const cleanup = (): void => {
        socket.off('connect', onConnect);
        socket.off('error', onError);
        signal.removeEventListener('abort', onAbort);
      };
      function onConnect(): void {
        cleanup();
        resolve(socket);
      }
      function onError(error: Error): void {
        cleanup();
        socket.destroy();
        reject(
          error instanceof NetworkError
            ? error
            : new NetworkError(
                'BROKER_UNREACHABLE',
                `cannot connect to ${host}:${String(port)} (${errnoOf(error)})`,
                { cause: error },
              ),
        );
      }
      function onAbort(): void {
        cleanup();
        socket.destroy();
        reject(signal.reason as Error);
      }
      socket.once('connect', onConnect);
      socket.once('error', onError);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** The caller's signal plus the connect timeout, and a way to tell them apart. */
  function limits(signal: AbortSignal | undefined): {
    combined: AbortSignal;
    explain: (error: unknown, host: string, port: number) => Error;
  } {
    const timeout = AbortSignal.timeout(timeoutMs);
    return {
      combined:
        signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      explain: (error, host, port) =>
        timeout.aborted &&
        signal?.aborted !== true &&
        !(error instanceof NetworkError)
          ? new NetworkError(
              'BROKER_UNREACHABLE',
              `connecting to ${host}:${String(port)} timed out after ${String(timeoutMs)} ms`,
              { cause: error },
            )
          : error instanceof Error
            ? error
            : new Error(String(error)),
    };
  }

  async function dial(
    target: DialTarget,
    route: unknown,
    signal?: AbortSignal,
  ): Promise<DialResult> {
    requireDirect(route);
    const { host, port, purpose } = validateTarget(target);
    const { combined, explain } = limits(signal);
    try {
      combined.throwIfAborted();
      // Resolution and the policy can hang too (a slow resolver, a policy store); the deadline
      // and the caller's signal bound them like everything else.
      const approved = await abortable(approve(host, port, purpose), combined);
      combined.throwIfAborted();
      const tcp = await openTransport(host, port, approved, combined);
      if (target.tls === undefined) return { socket: tcp };
      const secured = await secureSocket(tcp, target.tls, host, {
        ...(target.servername === undefined ? {} : { hint: target.servername }),
        signal: combined,
      });
      if (secured.diagnostics.insecureOverride) {
        // The UI shows the red banner from the recorded profile; this is the audit trail. A
        // logger that throws must not leak the connection it was describing.
        try {
          options.log?.warn(
            {
              host,
              port,
              purpose,
              verified: secured.diagnostics.verified,
              failure: secured.diagnostics.failure,
            },
            'TLS verification is switched off for this connection',
          );
        } catch {
          // Ignored on purpose: the connection result already carries insecureOverride.
        }
      }
      return { socket: secured.socket, tls: secured.diagnostics };
    } catch (error) {
      throw explain(error, host, port);
    }
  }

  return {
    async check(target) {
      const { host, port, purpose } = validateTarget(target);
      const deadline = AbortSignal.timeout(timeoutMs);
      let addresses: readonly ResolvedAddress[];
      try {
        addresses = await abortable(resolveHost(host, resolver), deadline);
      } catch {
        return {
          allowed: false,
          reason: `cannot resolve ${host}`,
          resolved: [],
        };
      }
      const decision = await abortable(
        evaluatePolicy(policy, {
          host,
          port,
          purpose,
          addresses: addresses.map((entry) => entry.address),
        }),
        deadline,
      ).catch(() => ({
        allowed: false as const,
        reason: 'the egress policy failed, so the connection is refused',
      }));
      const resolved = addresses.map((entry) => entry.address);
      return decision.allowed
        ? { allowed: true, resolved }
        : { allowed: false, reason: decision.reason, resolved };
    },

    async connect(target, route, signal) {
      return (await dial(target, route, signal)).socket;
    },

    dial,

    async forwarder(target, route, signal) {
      if ('tls' in target) {
        throw invalid(
          'a forwarder carries raw bytes; the client does its own TLS',
        );
      }
      const { socket } = await dial({ ...target }, route, signal);
      return openForwarder(socket);
    },
  };
}
