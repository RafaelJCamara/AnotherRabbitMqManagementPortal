// The egress policy hook (DC-43). The Dialer asks it about every address a connection could use,
// at connect time, after DNS resolution and before any socket opens. The SSRF policy itself
// (deny loopback, link-local, metadata, private ranges; admin allow-list) lands with M3-09; this
// work item builds the place where it plugs in and proves the checks happen in the right order:
//
//   - names are resolved once, by the Dialer, and the connection uses exactly the addresses the
//     policy saw (no second lookup an attacker could answer differently: DNS rebinding);
//   - an IP literal never reaches a DNS lookup, so it is evaluated up front;
//   - a denial is an `EGRESS_DENIED` error before any socket exists.
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';

import { NetworkError } from '@app/net-truststore';

export interface EgressRequest {
  readonly host: string;
  readonly port: number;
  /** Why the connection is made, for example `mgmt-http` or `amqp`. */
  readonly purpose: string;
  /** Every address the connection may use, IPv4 and IPv6, as resolved. */
  readonly addresses: readonly string[];
}

export type EgressDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export interface EgressPolicy {
  evaluate(request: EgressRequest): EgressDecision | Promise<EgressDecision>;
}

/**
 * The policy until M3-09: everything is allowed. A desktop user dials their own network, so
 * private ranges are legitimate; the team server installs a deny-by-default policy.
 */
export const allowAllPolicy: EgressPolicy = {
  evaluate: () => ({ allowed: true }),
};

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/** Resolves a host name to every address it has. Replaced in tests. */
export type Resolver = (host: string) => Promise<readonly ResolvedAddress[]>;

export const systemResolver: Resolver = (host) =>
  new Promise((resolve, reject) => {
    dnsLookup(host, { all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(
        addresses.map((entry: LookupAddress) => ({
          address: entry.address,
          family: entry.family === 6 ? 6 : 4,
        })),
      );
    });
  });

/** An IP literal is its own resolution; a name goes to the resolver. */
export async function resolveHost(
  host: string,
  resolver: Resolver,
): Promise<readonly ResolvedAddress[]> {
  const family = isIP(host);
  if (family !== 0) {
    return [{ address: host, family: family === 6 ? 6 : 4 }];
  }
  return resolver(host);
}

export async function evaluatePolicy(
  policy: EgressPolicy,
  request: EgressRequest,
): Promise<EgressDecision> {
  // Read the answer as `unknown`: a policy is code from elsewhere, and only the boolean `true`
  // (not a truthy string or a number) is an allow. Anything else is a denial.
  const decision: unknown = await policy.evaluate(request);
  if (typeof decision !== 'object' || decision === null) {
    return { allowed: false, reason: 'denied by the egress policy' };
  }
  if ('allowed' in decision && decision.allowed === true) {
    return { allowed: true };
  }
  const reason = 'reason' in decision ? decision.reason : undefined;
  return {
    allowed: false,
    reason:
      typeof reason === 'string' && reason !== ''
        ? reason
        : 'denied by the egress policy',
  };
}

export function egressDenied(
  host: string,
  port: number,
  reason: string,
): NetworkError {
  return new NetworkError(
    'EGRESS_DENIED',
    `connection to ${host}:${String(port)} denied: ${reason}`,
  );
}

/**
 * A `lookup` for `net.connect` that serves the addresses already resolved and approved, in
 * order. Node's own connect logic (including happy eyeballs) then picks among exactly those.
 */
export function approvedLookup(
  host: string,
  approved: readonly ResolvedAddress[],
): LookupFunction {
  return (hostname, options, callback) => {
    if (hostname !== host) {
      // The connection was asked to resolve something else: refuse, never fall back to DNS.
      callback(
        new NetworkError(
          'EGRESS_DENIED',
          'a connection tried to resolve a name that was not approved',
        ),
        '',
        4,
      );
      return;
    }
    const wanted =
      options.family === 4 || options.family === 6 ? options.family : 0;
    const usable = approved.filter(
      (entry) => wanted === 0 || entry.family === wanted,
    );
    const first = usable[0];
    if (first === undefined) {
      callback(
        new NetworkError('BROKER_UNREACHABLE', `no usable address for ${host}`),
        '',
        4,
      );
      return;
    }
    if (options.all === true) {
      callback(
        null,
        usable.map((entry) => ({
          address: entry.address,
          family: entry.family,
        })),
      );
      return;
    }
    callback(null, first.address, first.family);
  };
}
