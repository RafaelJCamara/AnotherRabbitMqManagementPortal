// The ports of the connections service (M0-44). svc-connections stores profiles and their sealed
// credentials, seals and opens them, and tests an endpoint; it imports no adapter, so each of those
// is a port here. `persistence` implements `ConnectionStore`, `secrets` satisfies `FieldSealer`
// (its `FieldCipher` has the same shape), and the composition root implements `ConnectionProber`
// over the management HTTP adapter and the AMQP adapter, both of which dial through the Dialer (I-9).
import type { Window } from './repos.ts';

/** A connection profile has one credential per protocol: they are never shared (DC-37). */
export type CredentialProtocol = 'http' | 'amqp';

export type ConnectionVisibility = 'private' | 'team';

/** One stored profile. `config` is JSON that svc-connections owns and validates on read. */
export interface ConnectionRecord {
  readonly id: string;
  readonly name: string;
  readonly envClass: string;
  readonly color: string | null;
  readonly config: unknown;
  readonly ownerId: string | null;
  readonly visibility: ConnectionVisibility;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** What a caller supplies; the store stamps the times and keeps `createdAt` on a replace. */
export type ConnectionInput = Omit<ConnectionRecord, 'createdAt' | 'updatedAt'>;

/** A sealed credential: ciphertext made by a `FieldSealer`, never the secret itself. */
export interface CredentialRecord {
  readonly protocol: CredentialProtocol;
  readonly ciphertext: Uint8Array;
  readonly updatedAt: number;
}

/** Credential changes that are stored in the same transaction as the profile row. */
export interface CredentialChange {
  readonly put?: Readonly<Partial<Record<CredentialProtocol, Uint8Array>>>;
  readonly remove?: readonly CredentialProtocol[];
}

export interface ConnectionListQuery {
  /** Only profiles this principal may see: its own, and every `team` profile. */
  readonly visibleTo: string;
  readonly limit: number;
  readonly cursor?: string;
}

export interface ConnectionStore {
  get(id: string): Promise<ConnectionRecord | undefined>;
  /**
   * Inserts or replaces the profile and applies the credential changes, all or nothing. Returns the
   * stored row.
   */
  save(
    profile: ConnectionInput,
    credentials?: CredentialChange,
  ): Promise<ConnectionRecord>;
  /** Deletes the profile and every credential of it. True when the profile existed. */
  delete(id: string): Promise<boolean>;
  /** Profiles in id order, in windows (I-7). */
  list(query: ConnectionListQuery): Promise<Window<ConnectionRecord>>;
  /** How many profiles `principalId` may see. */
  count(visibleTo: string): Promise<number>;
  /** The sealed credentials of a profile: at most one per protocol. */
  credentials(id: string): Promise<readonly CredentialRecord[]>;
}

/**
 * Seals and opens a stored secret. The place it lives in (`table:column:rowId`) is part of the
 * authenticated data, so a ciphertext moved to another row fails to open. `@app/secrets`'
 * `FieldCipher` satisfies this structurally, and rejects while the vault is locked.
 */
export interface FieldSealer {
  seal(
    table: string,
    column: string,
    rowId: string,
    plaintext: Uint8Array,
  ): Promise<Uint8Array>;
  open(
    table: string,
    column: string,
    rowId: string,
    sealed: Uint8Array,
  ): Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------------------------
// Testing an endpoint. A prober dials a draft or a saved profile with the credentials it is given
// for the one call and keeps none of them. The two protocols are separate calls on purpose: a broker
// whose management API answers while its AMQP port is blocked is a normal, specific situation.
// ---------------------------------------------------------------------------------------------

export type ProbeHttpAuth =
  | {
      readonly kind: 'basic';
      readonly username: string;
      readonly password: string;
    }
  | { readonly kind: 'bearer'; readonly token: string }
  | { readonly kind: 'none' };

export interface ProbeHttpEndpoint {
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
  /** `management.path_prefix` of the broker, for example `/rabbitmq`. */
  readonly pathPrefix?: string;
  readonly auth: ProbeHttpAuth;
}

export type ProbeAmqpAuth =
  | {
      readonly kind: 'plain';
      readonly username: string;
      readonly password: string;
    }
  | { readonly kind: 'none' };

export interface ProbeAmqpEndpoint {
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
  readonly vhost: string;
  readonly auth: ProbeAmqpAuth;
}

/** Why a probe failed. Stable tokens: svc-connections turns them into specific, honest messages. */
export type ProbeFailureReason =
  /** The connection was refused, reset or the host did not resolve: nothing answered. */
  | 'unreachable'
  | 'timeout'
  /** The egress policy refused the target (I-9). */
  | 'egress-denied'
  | 'tls-untrusted'
  /** The broker rejected the login. */
  | 'auth-refused'
  /** The login works but the user has no management tag (HTTP only). */
  | 'missing-tag'
  /** Something answered on the port, but it is not a RabbitMQ management API (HTTP only). */
  | 'not-management'
  /** The login works but the user may not use the vhost (AMQP only). */
  | 'vhost-refused'
  | 'unexpected';

export interface ProbeFailure {
  readonly reason: ProbeFailureReason;
  /** Safe text the broker or the adapter gave (no credential, no URL); optional. */
  readonly detail?: string;
}

/** What `/api/overview` and `/api/whoami` told, bounded by the prober. */
export interface HttpProbeFacts {
  readonly product?: string;
  readonly version?: string;
  readonly clusterName?: string;
  readonly user?: string;
  readonly tags: readonly string[];
  /** `/api/overview` `listeners`: the protocols the broker listens on. */
  readonly listeners: readonly {
    readonly protocol: string;
    readonly port: number;
  }[];
}

export type HttpProbeResult =
  | { readonly ok: true; readonly facts: HttpProbeFacts }
  | { readonly ok: false; readonly failure: ProbeFailure };

export type AmqpProbeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: ProbeFailure };

export interface ConnectionProber {
  /** Never rejects for a failure of the broker or the network: that is `{ ok: false }`. */
  http(
    endpoint: ProbeHttpEndpoint,
    signal: AbortSignal,
  ): Promise<HttpProbeResult>;
  /** Opens a connection to the vhost, logs in, closes it. Sends no message, declares nothing. */
  amqp(
    endpoint: ProbeAmqpEndpoint,
    signal: AbortSignal,
  ): Promise<AmqpProbeResult>;
}
