// The evidence a peek preflight needs from the topology read (M1-13, OQ-1468): which queues can
// dead-letter into the peeked queue (amendment A-2) and what configuration applies to it. Both are
// computed by svc-topology from a whole-vhost snapshot, and a service may not import a service, so
// svc-peek sees only this port. The composition root implements it over ActionExecutor.run of the
// query actions `routing.dlx-sources` and `queues.effective-config`, with the caller's principal,
// so permission and the snapshot cache are reused. Reads only: nothing here changes a broker.
import type {
  ConnectionId,
  QueuesEffectiveConfigOutputSchema,
  RoutingDlxSourcesOutputSchema,
} from '@app/contracts';
import type { z } from 'zod';

import type { Principal } from './connection-manager.ts';

/** As `routing.dlx-sources` answers it: sources with limits, `complete` and `unknownReasons`. */
export type RoutingDlxSourcesOutput = z.infer<
  typeof RoutingDlxSourcesOutputSchema
>;

/** As `queues.effective-config` answers it: per key a value, a status and its provenance. */
export type QueuesEffectiveConfigOutput = z.infer<
  typeof QueuesEffectiveConfigOutputSchema
>;

export interface PeekEvidenceRequest {
  readonly connectionId: ConnectionId;
  readonly vhost: string;
  readonly queue: string;
}

export interface PeekEvidencePort {
  dlxSources(
    request: PeekEvidenceRequest & {
      /** The `x-death` sources of messages the caller already holds; a preflight holds none. */
      readonly heldDeathSources?: readonly string[];
    },
    principal: Principal,
    signal: AbortSignal,
  ): Promise<RoutingDlxSourcesOutput>;
  effectiveConfig(
    request: PeekEvidenceRequest,
    principal: Principal,
    signal: AbortSignal,
  ): Promise<QueuesEffectiveConfigOutput>;
}
