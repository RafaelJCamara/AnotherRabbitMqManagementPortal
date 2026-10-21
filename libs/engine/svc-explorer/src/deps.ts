import type { Clock, Timers } from '@app/kernel';
import type {
  BrokerProfileStore,
  ConnectionStore,
  MgmtReadPort,
} from '@app/ports';

/** Bounds of the engine-resident index and of its sweeps (Q-12). Every one is overridable in a spec. */
export interface ExplorerLimits {
  /** The most rows of one connection the index keeps; more are dropped and counted. */
  maxRowsPerConnection: number;
  /** The most bytes of one connection the index keeps, by an estimate per row. */
  maxBytesPerConnection: number;
  /** Rows per management page; never above the adapter's page ceiling. */
  pageSize: number;
  /** More vhosts than this are counted and reported, not swept. */
  maxVhostsPerSweep: number;
  sweepMinIntervalMs: number;
  sweepMaxIntervalMs: number;
  /** Multiplies the time of the last sweep into the wait before the next. */
  sweepCostFactor: number;
  /** No demand for this long stops the sweeps of a connection. */
  idleStopMs: number;
  /**
   * The most bindings of one connection kept resident, across its vhosts (scale-first: 500,000).
   * Bindings are loaded per vhost on demand; rows past it are dropped and counted, and the least
   * recently used other vhosts are evicted, and counted, to stay under it.
   */
  maxBindingsResident: number;
  /** A resident vhost older than this is read again by the next query for it. */
  bindingsMaxAgeMs: number;
}

export const DEFAULT_EXPLORER_LIMITS: ExplorerLimits = {
  maxRowsPerConnection: 250_000,
  maxBytesPerConnection: 128 * 1024 * 1024,
  pageSize: 500,
  maxVhostsPerSweep: 5_000,
  sweepMinIntervalMs: 30_000,
  sweepMaxIntervalMs: 900_000,
  sweepCostFactor: 50,
  idleStopMs: 600_000,
  maxBindingsResident: 500_000,
  bindingsMaxAgeMs: 60_000,
};

export interface ExplorerModuleDeps {
  /** The BrokerScheduler's read wrapper: this module never gets the adapter or a write port (I-2, I-8). */
  readonly mgmt: MgmtReadPort;
  /** Reads the cached BrokerProfile (`repos.brokerProfiles`); the module never writes it. */
  readonly profiles: Pick<BrokerProfileStore, 'get'>;
  /** Only to tell whether the caller may see a connection. */
  readonly connections: Pick<ConnectionStore, 'get'>;
  readonly clock?: Clock;
  readonly timers?: Timers;
  readonly limits?: Partial<ExplorerLimits>;
}
