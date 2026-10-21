// The broker-facing ports of the engine, built once in the composition root (blueprint 1, I-8, I-9):
// the management read port over the adapter, the wire probe and the connection prober. Every socket
// they open is made by the Dialer, with the TrustStore of the process. This file never asks which
// mode runs: the mode is data, only the name a connection carries.
import { createMgmtHttpClient } from '@app/adapter-mgmt-http';
import type { Logger } from '@app/kernel';
import { createDialer, isRegisteredPurpose } from '@app/net-dialer';
import type { TrustStore } from '@app/net-truststore';
import type {
  BrokerProfileStore,
  BrokerWireProbe,
  ConnectionProber,
  ConnectionStore,
  FieldSealer,
  MgmtReadPort,
} from '@app/ports';

import { createConnectionProber } from './connection-prober.ts';
import { createConnectionEndpoints } from './endpoints.ts';
import { createMgmtTargetResolver } from './mgmt.ts';
import { createWireProbe } from './wire-probe.ts';

export interface BrokerPortsInput {
  readonly connections: Pick<ConnectionStore, 'get' | 'credentials'>;
  readonly profiles: Pick<BrokerProfileStore, 'get'>;
  /** Opens the sealed credentials of a profile; rejects while the vault is locked. */
  readonly sealer: FieldSealer;
  readonly trust: TrustStore;
  readonly logger: Logger;
  /** The `connection_name` mode part; data, never compared. */
  readonly mode: string;
}

export interface BrokerPorts {
  /**
   * GET requests to the management API, **not scheduled**: the composition root wraps it with the
   * BrokerScheduler (`scheduleMgmtRead`) before any service sees it (I-8).
   */
  readonly mgmt: MgmtReadPort;
  readonly wire: BrokerWireProbe;
  readonly prober: ConnectionProber;
  /** Drops the sockets the ports hold. Called once, at shutdown. */
  close(): void;
}

/** What `composeEngine` calls; a spec passes a factory that answers from fakes. */
export type BrokerPortsFactory = (input: BrokerPortsInput) => BrokerPorts;

export const createBrokerPorts: BrokerPortsFactory = (input) => {
  const dialer = createDialer({
    // I-12: only the purposes of the outbound-calls page can be dialled.
    purposes: isRegisteredPurpose,
    log: input.logger,
  });
  const endpoints = createConnectionEndpoints({
    connections: input.connections,
    sealer: input.sealer,
  });
  const client = createMgmtHttpClient({
    dialer,
    targets: createMgmtTargetResolver({
      endpoints,
      profiles: input.profiles,
      trust: input.trust,
    }),
  });
  return {
    mgmt: client.read,
    wire: createWireProbe({
      endpoints,
      dialer,
      trust: input.trust,
      mode: input.mode,
    }),
    prober: createConnectionProber({
      dialer,
      trust: input.trust,
      mode: input.mode,
    }),
    close: () => {
      client.close();
    },
  };
};
