// The ports of the identity service (M1-23): where a broker login comes from, how a token is asked
// for, how a configured command is run and what the TokenManager asks of a live connection. The
// service imports no adapter and no socket library (I-9), so each of those is a port here; the
// composition root implements them. A secret crosses these ports only as the argument or result of
// the one call that needs it, and is in no URL, argv, environment or error (I-10).
import type { CredentialProtocol } from './connections.ts';

export type RenewalProtocol = 'http' | 'amqp091' | 'amqp10' | 'stream';

/** One RFC 6749 4.4 request. The secret is in `clientSecret` and nowhere in the URL. */
export interface TokenRequest {
  /** An https URL, or http only for a loopback lab issuer (OQ-1462). */
  readonly endpoint: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scope?: string;
  readonly audience?: string;
  /**
   * Extra CAs (PEM) for this issuer only, added to the system trust when the adapter verifies an
   * https endpoint (N3, OQ-1559). They belong to the identity provider that sent the request and
   * are never kept for another one. There is no field that switches verification off: the insecure
   * override does not exist for a token request.
   */
  readonly tlsCa?: readonly string[];
}

export type TokenEndpointFailure =
  | 'unreachable'
  | 'egress-denied'
  | 'tls-untrusted'
  | 'timeout'
  | 'refused'
  | 'malformed'
  | 'too-large';

export type TokenResponse =
  | {
      ok: true;
      accessToken: string;
      expiresInSeconds: number | null;
      tokenType: string;
    }
  | { ok: false; reason: TokenEndpointFailure };

export interface TokenEndpointPort {
  requestToken(
    request: TokenRequest,
    signal: AbortSignal,
  ): Promise<TokenResponse>;
}

/** Runs a configured command without a shell. Implemented in apps/engine (OQ-1460). */
export interface CommandRunnerPort {
  run(
    command: { readonly file: string; readonly args: readonly string[] },
    limits: { readonly timeoutMs: number; readonly maxStdoutBytes: number },
    signal: AbortSignal,
  ): Promise<
    | { ok: true; stdout: string }
    | {
        ok: false;
        reason: 'spawn-failed' | 'exit-nonzero' | 'timeout' | 'too-large';
      }
  >;
}

/**
 * The login stored for one protocol of a profile, opened for this call. `svc-identity` cannot import
 * the connections service that owns the sealed rows, so the composition root implements this over
 * `ConnectionStore.credentials` and `FieldSealer.open` (the pair `apps/engine/src/broker/endpoints.ts`
 * uses). `username` is the profile's stored user name, or null when none is stored; `secret` is the
 * password, or the token for a static token. `locked` is a vault that cannot open it (or a row that
 * was moved or changed); `absent` is a profile with no such credential.
 */
export interface StoredLoginPort {
  open(
    connectionId: string,
    protocol: CredentialProtocol,
  ): Promise<
    | {
        readonly kind: 'found';
        readonly username: string | null;
        readonly secret: string;
      }
    | { readonly kind: 'locked' }
    | { readonly kind: 'absent' }
  >;
}

/** What the TokenManager asks of a live connection. The ConnectionManager implements it. */
export interface ConnectionAuthPort {
  /** AMQP 0-9-1 `connection.update-secret`. Rejects when the broker refuses (for example a different user). */
  updateSecret(
    connectionId: string,
    secret: string,
    reason: string,
  ): Promise<void>;
  /** AMQP 1.0 `PUT /auth/tokens` (4.1+). No implementation until M1-07 (OQ-1464). */
  putAuthToken?(connectionId: string, token: string): Promise<void>;
  /** Close and open again with the current credential (AMQP 1.0 on 4.0, streams). */
  reconnect(connectionId: string, protocol: RenewalProtocol): Promise<void>;
  /** Cancel the consumers the engine itself holds on this connection. Returns how many. */
  cancelOwnConsumers(
    connectionId: string,
    reason: 'token-expired',
  ): Promise<{ cancelled: number }>;
  /** The broker closed the connection with 320 CONNECTION_FORCED 'credential expired' (4.2.6+). */
  onCredentialExpiredClose(
    listener: (connectionId: string) => void,
  ): () => void;
}

/**
 * The most bytes of JSON one provider config may take (M1-23 slice E). The schema of the config is
 * `svc-identity`'s and bounds every field (the largest valid `token-command` config is under 150 KiB
 * of UTF-8); this is the store's own bound, so a row can never be larger than the reader will parse
 * (I-6). A write over it is refused, and a stored row over it reads as `unreadable`.
 */
export const CREDENTIAL_PROVIDER_MAX_CONFIG_BYTES = 262_144;

/**
 * The non-secret settings of one credential provider of one profile, as stored
 * (`credential_providers`, ADR-036). `config` is a JSON document that the owner of the schema,
 * `svc-identity`, validates on every read: the store holds it as it was written and never decides
 * what it means. It holds no secret; the secret stays in the profile's sealed `credentials` row.
 */
export interface CredentialProviderRecord {
  readonly connectionId: string;
  readonly protocol: CredentialProtocol;
  readonly config: unknown;
  readonly updatedAt: number;
}

/**
 * What a read finds. `unreadable` is a row whose stored text is not JSON or is over the size bound
 * (a damaged or hand-edited database): a fixed answer, never a thrown parse error and never the text.
 */
export type CredentialProviderRead =
  | { readonly kind: 'found'; readonly record: CredentialProviderRecord }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable' };

/**
 * The provider config of a profile, one per (connection id, protocol). The row goes with its
 * connection (`ConnectionStore.delete`). No action or UI writes it yet (OQ-1455, a follow-up issue).
 */
export interface CredentialProviderStore {
  get(
    connectionId: string,
    protocol: CredentialProtocol,
  ): Promise<CredentialProviderRead>;
  /**
   * Inserts or replaces the config of one (connection, protocol). `config` must be a JSON value no
   * larger than `CREDENTIAL_PROVIDER_MAX_CONFIG_BYTES` once serialised, or the call rejects with a
   * fixed error that does not repeat it.
   */
  put(
    connectionId: string,
    protocol: CredentialProtocol,
    config: unknown,
  ): Promise<void>;
  /** True when a row was removed. */
  delete(connectionId: string, protocol: CredentialProtocol): Promise<boolean>;
}
