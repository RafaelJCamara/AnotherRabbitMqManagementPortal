// The ports of the capability probe (M0-45). svc-capabilities reads the management API through
// `MgmtReadPort`; the two steps that need a socket of their own (the TLS handshake and the AMQP
// handshake, fact sheet j.2 steps 1 and 12) and the cache of the result are ports here, because a
// service imports no adapter and opens no socket (I-9). The composition root implements `BrokerWireProbe`
// over the Dialer, the TrustStore and the AMQP adapter, and `persistence` implements the store.
import type { ConnectionId } from '@app/contracts';

import type { ProbeFailure } from './connections.ts';

/** Where the profile points, as far as the probe needs to know it (host fingerprint, Prometheus URLs). */
export interface WireTarget {
  /** The management host; the Prometheus listener URLs are built on it. Never a credential. */
  readonly host: string;
  readonly managementTls: boolean;
}

/** The outcome of the TLS handshake on the management endpoint (step 1). */
export type TlsProbeResult =
  /** The endpoint is plain HTTP: there is no handshake to check. */
  | { readonly kind: 'plain' }
  | {
      readonly kind: 'checked';
      /** The chain verified against the trust the profile configures. */
      readonly verified: boolean;
      /** The profile turns verification off (it says exactly `insecure: true`). */
      readonly insecureOverride: boolean;
      /** Certificate expiry, epoch milliseconds. */
      readonly notAfter?: number;
    }
  | { readonly kind: 'failed'; readonly failure: ProbeFailure };

/** The outcome of the AMQP handshake (step 12): what the broker said in `connection.start` and `tune`. */
export type AmqpHandshakeResult =
  | {
      readonly ok: true;
      /** Server properties `product` and `version`, when the broker sends them. */
      readonly product?: string;
      readonly version?: string;
      /** The negotiated or advertised limits, when the adapter reports them. */
      readonly channelMax?: number;
      readonly frameMax?: number;
    }
  | { readonly ok: false; readonly failure: ProbeFailure };

/** Network-level probe steps. Neither sends a message nor declares anything. */
export interface BrokerWireProbe {
  /** Undefined when the connection no longer exists. */
  describe(
    connectionId: ConnectionId,
    signal: AbortSignal,
  ): Promise<WireTarget | undefined>;
  /** Never rejects for a failure of the broker or the network: that is `{ kind: 'failed' }`. */
  tls(connectionId: ConnectionId, signal: AbortSignal): Promise<TlsProbeResult>;
  /** Opens a connection, reads the server's answer, closes it. Never rejects for a broker failure. */
  amqpHandshake(
    connectionId: ConnectionId,
    signal: AbortSignal,
  ): Promise<AmqpHandshakeResult>;
}

/** One cached BrokerProfile (`broker_profiles`). `profile` is JSON that svc-capabilities validates on read. */
export interface BrokerProfileRecord {
  readonly connectionId: string;
  readonly fingerprint: string;
  readonly verification: string;
  readonly probedAt: number;
  readonly profile: unknown;
}

/** The cache of probed profiles, one per connection. */
export interface BrokerProfileStore {
  get(connectionId: string): Promise<BrokerProfileRecord | undefined>;
  /** Inserts or replaces the profile of a connection. */
  put(record: BrokerProfileRecord): Promise<void>;
  /** True when a profile was stored. */
  delete(connectionId: string): Promise<boolean>;
}
