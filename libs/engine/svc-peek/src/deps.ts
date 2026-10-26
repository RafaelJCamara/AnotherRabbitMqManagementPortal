import type { Clock } from '@app/kernel';
import type { MgmtReadPort, PeekEvidencePort } from '@app/ports';

/** The ports this module needs, injected by the composition root; each has a fake in testing.ts. */
export interface PeekModuleDeps {
  /** The read port only (the BrokerScheduler's wrapper), so a peek preflight cannot write (I-2). */
  readonly mgmt: MgmtReadPort;
  /** Dead-letter sources and effective configuration, wired over the topology queries (OQ-1468). */
  readonly evidence: PeekEvidencePort;
  readonly clock: Clock;
  /** The prefix of the quarantine queue's name; a bad one fails when the preflight is created. */
  readonly quarantinePrefix: string;
}
