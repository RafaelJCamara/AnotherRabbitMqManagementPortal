// Async repository ports (blueprint 4.3, I-5): every method returns a Promise from day one, so
// SQLite can move behind one storage worker without touching a caller. Collections are paged by
// keyset and bounded (I-7); nothing here lists "all".
import type {
  AuditRepository,
  CaptureRepository,
  PublishHistoryRepository,
  ConnectionStore,
  DataKeyRepository,
  IdempotencyRepository,
  JobStore,
  PlanRepository,
  ReceiptRepository,
  WorkspaceRepository,
  BrokerProfileStore,
} from '@app/ports';

/** A value that survives JSON.stringify and JSON.parse unchanged. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface SettingEntry {
  readonly key: string;
  readonly value: JsonValue;
}

/** Scoped key/value documents: workspace settings, layouts, keybindings. */
export interface SettingsRepository {
  get(scope: string, key: string): Promise<JsonValue | undefined>;
  /** Inserts or replaces. */
  set(scope: string, key: string, value: JsonValue): Promise<void>;
  /** True when the key existed. */
  delete(scope: string, key: string): Promise<boolean>;
  /** Entries of one scope in key order: at most `limit` (default 200), after `afterKey`. */
  list(
    scope: string,
    page?: { limit?: number; afterKey?: string },
  ): Promise<readonly SettingEntry[]>;
}

export type ConnectionVisibility = 'private' | 'team';

export interface ConnectionProfileRecord {
  readonly id: string;
  readonly name: string;
  /** Environment class (for example production, staging): drives guardrails and colour. */
  readonly envClass: string;
  readonly color: string | null;
  /** Endpoints, dial route, TLS, credential references, issuer pin, managed flags. */
  readonly config: JsonValue;
  readonly ownerId: string | null;
  readonly visibility: ConnectionVisibility;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** What a caller supplies; the repository stamps the times. */
export type ConnectionProfileInput = Omit<
  ConnectionProfileRecord,
  'createdAt' | 'updatedAt'
>;

export interface ConnectionProfileRepository {
  /** Inserts, or replaces the profile with the same id and keeps its `createdAt`. */
  save(profile: ConnectionProfileInput): Promise<ConnectionProfileRecord>;
  get(id: string): Promise<ConnectionProfileRecord | undefined>;
  /** True when the profile existed. */
  delete(id: string): Promise<boolean>;
  /** Profiles in id order: at most `limit` (default 100), after `afterId`. */
  list(page?: {
    limit?: number;
    afterId?: string;
  }): Promise<readonly ConnectionProfileRecord[]>;
}

/** Content-addressed, reference-counted bodies. Encryption is the caller's (M0-22). */
export interface BlobRepository {
  /** Stores the bytes (or adds a reference to the same bytes) and returns their sha256 and count. */
  put(body: Uint8Array): Promise<{ sha256: string; refcount: number }>;
  get(sha256: string): Promise<Uint8Array | undefined>;
  /** Drops one reference and deletes the body at zero. Returns the count left; undefined when unknown. */
  release(sha256: string): Promise<number | undefined>;
}

export interface Repositories {
  readonly settings: SettingsRepository;
  readonly connectionProfiles: ConnectionProfileRepository;
  /** Profiles with their sealed credentials, changed together (M0-44). The port is @app/ports'. */
  readonly connections: ConnectionStore;
  readonly blobs: BlobRepository;
  /** The ActionExecutor's plans (M0-29). The port is @app/ports'; the kernel owns the policy. */
  readonly plans: PlanRepository;
  readonly idempotency: IdempotencyRepository;
  /** The hash-chained audit and the receipts (M0-30). The kernel owns the chain. */
  readonly audit: AuditRepository;
  readonly receipts: ReceiptRepository;
  /** Wrapped data keys (M0-22). The port is @app/ports'; @app/secrets owns the cryptography. */
  readonly dataKeys: DataKeyRepository;
  /** Durable jobs (M0-31). The port is @app/ports'; `@app/jobs` owns the policy. */
  readonly jobs: JobStore;
  /** Saved views, layouts, settings and keybindings (M0-47). The port is @app/ports'. */
  readonly workspace: WorkspaceRepository;
  /** The cache of probed BrokerProfiles (M0-45). The port is @app/ports'. */
  readonly brokerProfiles: BrokerProfileStore;
  /** Saved captures: sealed messages, blobs and the full-text index (M1-09). The port is @app/ports'. */
  readonly captures: CaptureRepository;
  /** What a person published, per owner and connection, with the sealed masked document (M1-19). The port is @app/ports'. */
  readonly publishHistory: PublishHistoryRepository;
}
