import type { Clock } from '@app/kernel';
import type {
  BrokerProfileStore,
  ConnectionStore,
  MgmtReadPort,
} from '@app/ports';

/**
 * Bounds of a snapshot of one vhost and of the work done on it (R3). A kind past its bound keeps its
 * first rows and the rest is counted, never silent (I-6, I-13). Every one is overridable in a spec.
 */
export interface TopologyLimits {
  /** The most queues of one vhost read; the rest are counted. */
  maxQueues: number;
  maxExchanges: number;
  /** Bindings are read as one array by the port, so this cuts after the answer. */
  maxBindings: number;
  maxConsumers: number;
  /** More policies than this make the list unreadable (a missing policy would be a wrong answer). */
  maxPolicies: number;
  /** Rows per management page; never above the broker's page ceiling. */
  pageSize: number;
  /** A finished snapshot answers further calls for this long. */
  snapshotTtlMs: number;
  /** Snapshots kept; the oldest goes first. */
  maxSnapshots: number;
  /** Rows converted between two turns of the event loop (I-5). */
  yieldEveryItems: number;
}

export const DEFAULT_TOPOLOGY_LIMITS: TopologyLimits = {
  maxQueues: 50_000,
  maxExchanges: 10_000,
  maxBindings: 200_000,
  maxConsumers: 100_000,
  maxPolicies: 1_000,
  pageSize: 500,
  snapshotTtlMs: 15_000,
  maxSnapshots: 8,
  yieldEveryItems: 500,
};

export interface TopologyModuleDeps {
  /** The BrokerScheduler's read wrapper: this module never gets the adapter or a write port (I-2, I-8). */
  readonly mgmt: MgmtReadPort;
  /** Reads the cached BrokerProfile (`repos.brokerProfiles`); the module never writes it. */
  readonly profiles: Pick<BrokerProfileStore, 'get'>;
  /** Only to tell whether the caller may see a connection. */
  readonly connections: Pick<ConnectionStore, 'get'>;
  readonly clock?: Clock;
  readonly limits?: Partial<TopologyLimits>;
  /** One turn of the event loop; a spec counts the calls instead of timing them. */
  readonly yieldNow?: () => Promise<void>;
}
