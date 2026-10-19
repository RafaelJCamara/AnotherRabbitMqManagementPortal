import type {
  BrokerProfileStore,
  BrokerWireProbe,
  ConnectionStore,
  MgmtReadPort,
} from '@app/ports';
import type { BrokerSemanticsRegistry } from '@app/semantics';

/**
 * The ports this module needs, injected by the composition root. Everything is read-only on the
 * broker: `mgmt` is the BrokerScheduler's read wrapper (I-8) and the module is never handed a
 * `MgmtWritePort`, so the probe cannot send a write-shaped request. The cache is the one thing it
 * writes, and that is derived data (OQ-470).
 */
export interface CapabilitiesModuleDeps {
  /** GET requests to the management API, through the BrokerScheduler. */
  readonly mgmt: MgmtReadPort;
  /** The TLS and AMQP handshakes, which need a socket (Dialer and TrustStore, I-9). */
  readonly wire: BrokerWireProbe;
  /** The cache of probed profiles: `repos.brokerProfiles` of `@app/persistence`. */
  readonly profiles: BrokerProfileStore;
  /** Only to tell whether the caller may see a connection: `repos.connections` of `@app/persistence`. */
  readonly connections: Pick<ConnectionStore, 'get'>;
  /** Broker versions with a green conformance run (OQ-100). Empty until the evidence work names a source. */
  readonly lastVerified?: () => readonly string[];
  /** The semantics registry; the one this release ships when absent. */
  readonly registry?: BrokerSemanticsRegistry;
}
