// The Dialer (I-9): every outbound socket is made here, after the egress policy and the TrustStore
// have been consulted. Implemented by net-dialer.
// `node:net` is confined to the net-* projects, adapters and listeners (I-9, eslint.config.mjs), so
// the port speaks in terms of the stream every socket is: a net.Socket or tls.TLSSocket is a Duplex.
import type { Duplex } from 'node:stream';

export interface DialTarget {
  host: string;
  port: number;
  /** Why the connection is made, for the egress policy and the audit trail. */
  purpose: string;
}

export interface DialCheck {
  allowed: boolean;
  reason?: string;
  resolved: string[];
}

export interface DialerPort {
  /** Asks the egress policy without connecting. */
  check(target: DialTarget): Promise<DialCheck>;
  /** `route` is the profile's route (direct, proxy, SSH tunnel); its shape belongs to net-dialer. */
  connect(
    target: DialTarget & { servername?: string },
    route: unknown,
    signal?: AbortSignal,
  ): Promise<Duplex>;
  /** A local forwarder path for clients that cannot take a socket (a Unix socket or a pipe). */
  forwarder(
    target: DialTarget,
    route: unknown,
  ): Promise<{ path: string; close(): Promise<void> }>;
}
