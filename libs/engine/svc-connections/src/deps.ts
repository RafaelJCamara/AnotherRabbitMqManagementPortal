import type {
  ConnectionProber,
  ConnectionStore,
  FieldSealer,
} from '@app/ports';

/**
 * The ports this module needs, injected by the composition root. A write to the store happens
 * inside an `implementAction` body only; the module never gets a broker write port (it makes no
 * change to a broker). The ConnectionManager (`createConnectionManager`) is separate: the executor
 * hands it to actions through its context.
 */
export interface ConnectionsModuleDeps {
  /** Profiles and their sealed credentials: `repos.connections` of `@app/persistence`. */
  readonly store: ConnectionStore;
  /** Seals and opens secrets: the data-key vault's `fields` cipher of `@app/secrets`. */
  readonly sealer: FieldSealer;
  /** Tests an endpoint over the adapters (the Dialer applies the egress policy, I-9). */
  readonly prober: ConnectionProber;
  /** A new, opaque, path-safe id for a profile (a ULID). */
  readonly newId: () => string;
}
