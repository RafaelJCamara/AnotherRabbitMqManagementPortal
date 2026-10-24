// The shapes of the peek planner (M1-12, blueprint 5.4, core-interfaces.md "Peek planner"). The
// input is what the preflight (M1-13) reads; the output is a plan the executor (M1-14) follows or a
// rejection with a closed code. Everything is readonly data: the planner never mutates its input.
//
// Differences from core-interfaces.md, each an open question of docs/specs/M1-12.md: the rejection
// carries text keys and closed reason codes instead of prose (OQ-1424); the preflight names the
// raw limit state, the two single-active-consumer facts, the dead-letter evidence with its
// `complete` flag and the rescue queue name (OQ-1427); the facts carry `nowMs` because a pure
// library reads no clock.
import type {
  CellId,
  ConnectionId,
  EnvClass,
  ObjectKey,
  WarningRef,
} from '@app/contracts';
import type {
  BrokerProfile,
  Era,
  QueueType,
  Verification,
} from '@app/domain-model';
import type {
  BrokerSemanticsRegistry,
  DeliveryLimit,
  LimitState,
  SettleEffect,
} from '@app/semantics';

export type { EnvClass };

/** The registry lookups the planner uses, and nothing else (I-3: it asks, it does not compare). */
export type PlannerRegistry = Pick<
  BrokerSemanticsRegistry,
  'version' | 'cell' | 'isDoomed' | 'peekCaps' | 'warning'
>;

/** The part of the broker profile the planner reads. */
export type PeekProfile = Pick<
  BrokerProfile,
  'era' | 'verification' | 'versions' | 'identity' | 'managedObjects' | 'gates'
>;

/**
 * Who asks. Structurally a kernel `Principal` (a pure library may not import the port type), with
 * only the fields the planner reads.
 */
export interface PeekPrincipal {
  readonly kind:
    | 'desktop-user'
    | 'local-token'
    | 'team-user'
    | 'api-token'
    | 'mcp-client'
    | 'job'
    | 'system';
  readonly surface: 'ui' | 'cli' | 'mcp' | 'job' | 'system';
  readonly unattended: boolean;
  readonly onBehalfOf?: PeekPrincipal | undefined;
}

export type PeekMethod =
  | 'amqp091.get'
  | 'amqp091.consumer-sac'
  | 'amqp10.credit1-step'
  | 'http.get_fallback';

export type PreferredMethod = 'amqp091' | 'amqp10-step' | 'http-fallback';

/** What to do with a message that a return would drop or dead-letter (DC-09). */
export type Disposition =
  | { readonly kind: 'quarantine'; readonly queue: string }
  | {
      readonly kind: 'raise-limit';
      readonly policyName: string;
      /** `-1` is unlimited; otherwise a finite limit above the current one. */
      readonly value: number;
    }
  | { readonly kind: 'let-broker-handle'; readonly typedConsent: string };

export interface PeekRequest {
  readonly connectionId: ConnectionId;
  readonly queue: ObjectKey;
  readonly count: number;
  readonly maxBytes?: number | undefined;
  readonly disposition?: Disposition | undefined;
  readonly prefer?: PreferredMethod | undefined;
}

/** The dead-letter evidence, as `routing.dlx-sources` answers it (A-2). */
export interface DlxEvidence {
  /** The queues that dead-letter into the peeked queue, with their limits. */
  readonly sources: readonly {
    readonly queue: string;
    readonly limit: DeliveryLimit;
  }[];
  /** True only when nothing was unknown. An empty list is "no hazard" only then. */
  readonly complete: boolean;
  readonly unknownReasons: readonly {
    readonly code: string;
    readonly subject?: string | undefined;
  }[];
}

/** The quarantine path, checked before any message is acquired (blueprint 5.5). */
export interface RescueFacts {
  /** The name of the quarantine queue; the planner does not invent it (the product name is a placeholder). */
  readonly queueName: string;
  readonly queueReady: boolean;
  readonly overflowSafe: boolean;
  readonly permissionOk: boolean;
  readonly alarms: readonly string[];
  readonly publishBlocked: boolean;
  readonly checkedAt: number;
}

export type DelayedRetryType = 'disabled' | 'all' | 'failed' | 'returned';

/** An absent field means "not read": the planner treats it as unknown, never as a default. */
export interface PreflightQueue {
  readonly type: QueueType;
  readonly exclusiveOwnedByOther: boolean;
  readonly autoDelete: boolean;
  /** The limit the broker reports (the `delivery_limit` stat), or `unknown` if it could not be read. */
  readonly deliveryLimit: DeliveryLimit;
  /** The configured form: `unset` and `minus1` are both unlimited to `DeliveryLimit` and differ on 3.13. */
  readonly limitState: LimitState;
  /** The stat and the recomputed limit when they disagree (W-UPGRADED). */
  readonly limitDisagreement?:
    | { readonly stat: DeliveryLimit; readonly computed: DeliveryLimit }
    | undefined;
  /** Set when an argument or an operator policy fixes the limit, so a policy cannot raise it (A-4). */
  readonly limitFixedBy?: 'argument' | 'operator-policy' | null | undefined;
  /** Finite limits seen anywhere (arguments, policies, stat); the estimate of A-2 takes their minimum. */
  readonly visibleLimits?: readonly number[] | undefined;
  readonly singleActiveConsumer: boolean;
  readonly hasActiveConsumer: boolean;
  readonly consumers: number;
  readonly ready?: number | undefined;
  /** Quorum health: a leader and a majority online. Absent is "not checked" and fails closed. */
  readonly quorumOk?: boolean | undefined;
  readonly avgBytes?: number | undefined;
  readonly delayedRetry?:
    | {
        readonly type: DelayedRetryType;
        readonly minMs?: number | undefined;
        readonly messagesDelayed?: number | undefined;
      }
    | undefined;
  readonly maxLength?: number | undefined;
  readonly overflow?:
    | 'drop-head'
    | 'reject-publish'
    | 'reject-publish-dlx'
    | undefined;
  readonly ttlMs?: number | undefined;
  readonly consumerTimeoutMs?: number | undefined;
}

export interface PeekPreflight {
  readonly queue: PreflightQueue;
  readonly dlxSources: DlxEvidence;
  /** Source queues named by the x-death of messages already seen (M1-04). Absent: not looked at. */
  readonly heldDeathSources?: readonly string[] | undefined;
  readonly rescue?: RescueFacts | undefined;
  /** Measured round trip of one get, in milliseconds. */
  readonly rttMs: number;
  readonly takenAt: number;
}

export interface PeekFacts {
  readonly profile: PeekProfile;
  readonly preflight: PeekPreflight;
  readonly principal: PeekPrincipal;
  readonly registry: PlannerRegistry;
  readonly env: EnvClass;
  /** Milliseconds since the epoch; the only clock the planner has. */
  readonly nowMs: number;
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

export type LimitBasis = 'unlimited' | 'finite' | 'finite-unknown';

export type LimitReason =
  | 'own-limit-unknown'
  | 'limit-incoherent'
  | 'dlx-evidence-unverified';

export type HoldBound =
  | 'hard-cap'
  | 'message-ttl'
  | 'consumer-timeout'
  | 'channel-timeout';

export type CapBound = 'cap' | 'hold' | 'bytes' | 'request';

export type PlannedDisposition =
  | { readonly kind: 'none'; readonly reason: 'classic' | 'unlimited' }
  | {
      readonly kind: 'quarantine';
      readonly queue: string;
      readonly chosenBy: 'request' | 'default';
    }
  | {
      readonly kind: 'raise-limit';
      readonly policyName: string;
      readonly value: number;
      readonly chosenBy: 'request';
    }
  | { readonly kind: 'let-broker-handle'; readonly chosenBy: 'request' };

export interface PeekPlanPreview {
  readonly era: Era;
  readonly verification: Verification;
  readonly semanticsVersion: string;
  /** Never `lab-verified`: the planner reads `code-derived` cells (OQ-1421). */
  readonly confidence: 'code-derived' | 'unverified-version';
  readonly queueType: 'classic' | 'quorum';
  readonly method: PeekMethod;
  readonly limit: {
    readonly basis: LimitBasis;
    readonly value?: number;
    readonly estimated: boolean;
    readonly reasons: readonly LimitReason[];
  };
  readonly caps: {
    readonly requested: number;
    readonly count: number;
    readonly bytes: number;
    readonly limitedBy: CapBound;
  };
  readonly hold: {
    readonly targetMs: number;
    readonly hardAbortMs: number;
    readonly derivedFrom: readonly HoldBound[];
  };
  readonly guard: {
    readonly counter: 'x-delivery-count';
    readonly doomedWhen: '>' | '>=';
    readonly limit: DeliveryLimit;
    readonly estimated: boolean;
    readonly stopAtFirstDoomed: true;
  };
  readonly disposition: PlannedDisposition;
  readonly expected: readonly {
    readonly cell: CellId;
    readonly effect: SettleEffect;
  }[];
  /** `not-in-registry` for a classic queue: the registry has no classic cells (OQ-1429). */
  readonly effects: 'registry' | 'not-in-registry';
  readonly evidence: {
    readonly dlx: 'not-applicable' | 'safe' | 'unknown';
    readonly heldDeath: 'covered' | 'not-checked';
  };
  /** Keys of registry rows that were missing and replaced by a conservative row (R12). */
  readonly gaps: readonly string[];
  /** The headline claim, as a text key ("side-effect-aware peek"). */
  readonly honestLabelKey: string;
}

/** Structurally a kernel `Gate`; always empty in M1-12 because every block is a rejection (OQ-1435). */
export interface PlanGate {
  readonly id: string;
  readonly blocking: boolean;
  readonly reason: string;
}

/** Structurally a kernel `PlanDraft<PeekPlanPreview>`. All lists are sorted. */
export interface PeekPlanDraft {
  readonly preview: PeekPlanPreview;
  readonly gates: readonly PlanGate[];
  readonly warnings: readonly WarningRef[];
  /** Consent ids: each `consent` warning adds its own, plus `disposition:let-broker-handle`. */
  readonly consentsRequired: readonly string[];
}
