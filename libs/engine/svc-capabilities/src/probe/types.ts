import type { ConnectionId } from '@app/contracts';
import type { Provider } from '@app/domain-model';
import type {
  AmqpHandshakeResult,
  BrokerWireProbe,
  MgmtReadPort,
  TlsProbeResult,
  WireTarget,
} from '@app/ports';
import type { BrokerSemanticsRegistry } from '@app/semantics';

import type { Overview } from './schemas';

export type StepId =
  | 'tls'
  | 'host-fingerprint'
  | 'oauth-discovery'
  | 'identity'
  | 'overview'
  | 'extensions'
  | 'nodes'
  | 'feature-flags'
  | 'vendor-fingerprints'
  | 'exchanges'
  | 'prometheus'
  | 'amqp-handshake';

/** What a step needs: the broker through its two read-only ports, and the registry. */
export interface ProbeEnv {
  readonly connectionId: ConnectionId;
  /** Reads only: the probe is never handed a `MgmtWritePort` (a write-shaped probe is on demand, OQ-471). */
  readonly mgmt: MgmtReadPort;
  readonly wire: BrokerWireProbe;
  readonly registry: BrokerSemanticsRegistry;
  readonly signal: AbortSignal;
}

/** One answer of `/api/overview`: which node said it, and what it said. */
export interface OverviewAnswer {
  readonly node: string | undefined;
  readonly overview: Overview;
}

export interface NodeFact {
  readonly name: string;
  readonly running: boolean;
  readonly beingDrained: boolean | undefined;
  readonly plugins: readonly string[] | undefined;
}

/**
 * What the steps learn, one field each. A field a step could not fill stays undefined: the profile
 * builder turns every undefined into the conservative reading (fewer capabilities, more hazards).
 */
export interface Facts {
  target?: WireTarget;
  tls?: TlsProbeResult;
  oauth?: { issuer: string; source: 'bootstrap.js' | 'api/auth' };
  identity?: { user: string; tags: readonly string[] };
  /** Every answer of `/api/overview`, in order; the first one is the reference. */
  overviews: OverviewAnswer[];
  extensions?: readonly string[];
  /** Undefined when the node list could not be read; then the membership of the cluster is unknown. */
  nodes?: readonly NodeFact[];
  featureFlags?: Readonly<Record<string, string>>;
  deprecatedUsed?: readonly string[];
  vendor?: {
    providers: readonly Provider[];
    objects: readonly {
      kind: 'policy' | 'operator-policy' | 'user';
      vhost?: string;
      name: string;
    }[];
  };
  exchanges?: { event: boolean | undefined; trace: boolean | undefined };
  prometheus?: readonly {
    node: string;
    url: string;
    source: 'provider' | 'listener' | 'default';
  }[];
  amqp?: AmqpHandshakeResult;
}

export type StepStatus = 'ok' | 'unavailable' | 'failed' | 'skipped';

export interface StepOutcome {
  readonly status: StepStatus;
  /** Safe text: a reason or a count. */
  readonly detail?: string;
}

export interface ProbeStep {
  readonly id: StepId;
  run(env: ProbeEnv, facts: Facts): Promise<StepOutcome>;
}

/** Why a step failed, from the code or the HTTP status an adapter error carries. Never its message. */
export function failureReason(error: unknown): {
  reason: string;
  status: StepStatus;
  code: string | undefined;
} {
  const fields =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown; broker?: { code?: unknown } })
      : {};
  const code = typeof fields.code === 'string' ? fields.code : undefined;
  const http =
    typeof fields.broker?.code === 'number' ? fields.broker.code : undefined;
  // The broker has no such endpoint, or this user's role may not read it: a normal answer.
  if (http === 404) {
    return { reason: 'not found (HTTP 404)', status: 'unavailable', code };
  }
  if (http === 401 || http === 403) {
    return {
      reason: `refused for this login (HTTP ${String(http)})`,
      status: 'unavailable',
      code,
    };
  }
  const text =
    http === undefined ? code : `${code ?? 'error'}, HTTP ${String(http)}`;
  return { reason: text ?? 'unexpected error', status: 'failed', code };
}
