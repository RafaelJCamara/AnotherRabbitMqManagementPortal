import type { Clock, Timers } from '@app/kernel';
import type { Collector } from './internal/collector';
import type {
  BrokerProfileStore,
  ConnectionStore,
  MgmtReadPort,
  PromReadPort,
} from '@app/ports';

/** The bounds and cadences of the metrics engine (OQ-865, OQ-866, OQ-869). Every one is overridable in a spec. */
export interface MetricsLimits {
  /** The fastest a Prometheus target is scraped. */
  baseIntervalMs: number;
  /** The slowest the cost rule may make it, unless the provider's own minimum is higher. */
  maxIntervalMs: number;
  /** The fastest the management fallback is read. */
  mgmtBaseIntervalMs: number;
  /** The interval is at least this many times the duration of the last scrape. */
  costFactor: number;
  /** A series is `stale` when its newest point is older than this many intervals. */
  staleAfterIntervals: number;
  /** Points one series keeps (one hour at five seconds). */
  ringPoints: number;
  /** Queue series one broker keeps; the highest backlogs and the pinned queues stay. */
  maxQueueSeries: number;
  /** Brokers whose series are held; the least recently used goes first. */
  maxBrokers: number;
  /** Queues one demand may name. */
  maxPinnedQueues: number;
  /** Per-object requests one target gets in a round. */
  maxDetailedRequests: number;
  /** Characters of one `queue=` regular expression. */
  maxQueryRegexChars: number;
  /** Vhosts an unfiltered detailed read may cover in a round. */
  maxDetailedVhosts: number;
  /** Samples one scrape may deliver; the read stops there and says so. */
  maxSamplesPerScrape: number;
  /** Bytes one scrape may carry. */
  maxBodyBytes: number;
  /** Candidates (series by node) one round may hold before merging. */
  maxRoundCandidates: number;
  /** A plan whose every target failed this many rounds in a row falls back to management. */
  failuresBeforeFallback: number;
  /** How long the fallback lasts before Prometheus is tried again. */
  fallbackCooldownMs: number;
  /** No demand for this long stops the collection of a connection. */
  idleStopMs: number;
  /** Queues the management fallback may read one by one (where per-object reads are allowed). */
  maxMgmtQueueReads: number;
}

export const DEFAULT_METRICS_LIMITS: MetricsLimits = {
  baseIntervalMs: 15_000,
  maxIntervalMs: 300_000,
  mgmtBaseIntervalMs: 30_000,
  costFactor: 10,
  staleAfterIntervals: 3,
  ringPoints: 720,
  maxQueueSeries: 2_000,
  maxBrokers: 64,
  maxPinnedQueues: 50,
  maxDetailedRequests: 8,
  maxQueryRegexChars: 2_000,
  maxDetailedVhosts: 8,
  maxSamplesPerScrape: 200_000,
  maxBodyBytes: 64 * 1024 * 1024,
  maxRoundCandidates: 50_000,
  failuresBeforeFallback: 3,
  fallbackCooldownMs: 300_000,
  idleStopMs: 600_000,
  maxMgmtQueueReads: 20,
};

export interface MetricsModuleDeps {
  /**
   * Prometheus scrapes read to samples, behind the BrokerScheduler's wrapper: this module never gets
   * the adapter, a chunk or a socket (I-8, I-9).
   */
  readonly prom: PromReadPort;
  /** The BrokerScheduler's read wrapper; the management fallback reads through it (I-8). */
  readonly mgmt: MgmtReadPort;
  /** Reads the cached BrokerProfile (`repos.brokerProfiles`); the module never writes it. */
  readonly profiles: Pick<BrokerProfileStore, 'get'>;
  /** Only to tell whether the caller may see a connection. */
  readonly connections: Pick<ConnectionStore, 'get'>;
  readonly clock?: Clock;
  readonly timers?: Timers;
  readonly limits?: Partial<MetricsLimits>;
}

/** What the actions and the live source share: the module's ports and the one collector. */
export type MetricsActionDeps = MetricsModuleDeps & {
  readonly collector: Collector;
};
