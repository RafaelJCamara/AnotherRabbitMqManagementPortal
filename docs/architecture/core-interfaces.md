# Core interfaces (TypeScript)

> **Design-phase output (2026-10-16).** Amended by [`docs/plan/amendments.md`](../plan/amendments.md), which takes precedence, and re-sequenced web-first ([ADR-030](../adr/ADR-030-web-first-delivery-order.md), [`docs/product/milestones.md`](../product/milestones.md)). Content about a specific third-party product was removed under the docs policy ([ADR-034](../adr/ADR-034-docs-policy.md)).

Amendment A-9 requires the settlement proofs below to be **nominal** (unique-symbol or private-constructor brands, minted only in PublishLease and the planner, with a runtime WeakSet check). Amendment A-1 replaces the counter-trust rule.

```ts
// =====================================================================================
// @app/contracts — contract kit (isomorphic; zod 4.6.7 only)
// =====================================================================================
import type { z } from 'zod';
export type Brand<T, B extends string> = T & { readonly __brand: B };
export type ConnectionId = Brand<string, 'ConnectionId'>;   // human-created opaque alias (DC-42)
export type ObjectKey = Brand<string, 'ObjectKey'>;         // base64url(utf8(vhost) 0x00 utf8(name))
export type ActionId = Brand<string, 'ActionId'>; export type TopicId = Brand<string, 'TopicId'>;
export type PlanId = Brand<string, 'PlanId'>; export type JobId = Brand<string, 'JobId'>;
export type ReceiptId = Brand<string, 'ReceiptId'>; export type FeatureId = Brand<string, 'FeatureId'>;
export type WarningId = `W-${string}`; export type CellId = `SEM-${string}`; export type ConformanceId = `CF-${string}`;
export type Permission = `${string}.${string}`;
export type EnvClass = 'prod' | 'staging' | 'test' | 'dev' | 'local';      // unset => 'prod'
export type Risk = 'none' | 'low' | 'medium' | 'high' | 'critical';
export type EngineMode = 'desktop' | 'local' | 'team';
export declare function encodeObjectKey(vhost: string, name: string): ObjectKey;
export declare function decodeObjectKey(k: ObjectKey): { vhost: string; name: string };

export interface TargetRef { connectionId?: ConnectionId; vhost?: string; kind?: string; name?: string; messageCount?: number }
export interface ActionDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  readonly id: ActionId; readonly kind: 'query' | 'command' | 'peek' | 'job'; readonly summary: string;
  readonly input: I; readonly output: O; readonly permission: Permission;
  readonly risk: Risk | ((input: z.infer<I>, env: EnvClass) => Risk);
  readonly planning: 'none' | 'optional' | 'required';                     // env policy may raise it
  readonly confirm?: { requiredWhen(env: EnvClass, risk: Risk): boolean; phrase(input: z.infer<I>): string };
  readonly audit: 'none' | 'outcome' | 'attempt+outcome';                  // mutating => attempt+outcome (kit test)
  readonly target: (input: z.infer<I>) => TargetRef;
  readonly http?: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: `/${string}` };
  readonly mcp?: { expose: boolean; mutating: boolean; title: string; description: string };
  readonly cli?: { command: string };
  readonly since: `${number}.${number}`;
}
export declare function defineAction<I extends z.ZodType, O extends z.ZodType>(d: ActionDef<I, O>): ActionDef<I, O>;
export type InputOf<A> = A extends ActionDef<infer I, any> ? z.infer<I> : never;
export type OutputOf<A> = A extends ActionDef<any, infer O> ? z.infer<O> : never;
export type Qos = 'lossless' | 'latest' | 'sampled';
export interface TopicDef<P extends z.ZodType = z.ZodType, T extends z.ZodType = z.ZodType> {
  readonly id: TopicId; readonly params: P; readonly item: T; readonly qos: Qos; readonly flow: 'credit' | 'snapshot-delta';
  readonly permission: Permission; readonly key?: (i: z.infer<T>) => string; readonly maxHz?: number;
  readonly ring: { items: number; bytes: number };
}
export declare function defineTopic<P extends z.ZodType, T extends z.ZodType>(d: TopicDef<P, T>): TopicDef<P, T>;

export type ErrorCode = 'VALIDATION_FAILED' | 'UNAUTHENTICATED' | 'FORBIDDEN_RBAC' | 'FORBIDDEN_BROKER' | 'NOT_FOUND'
  | 'PLAN_STALE' | 'PLAN_EXPIRED' | 'CAPABILITY_MISSING' | 'GATE_BLOCKED' | 'PLAN_REQUIRED' | 'CONSENT_REQUIRED'
  | 'APPROVAL_REQUIRED' | 'CONFIRMATION_MISMATCH' | 'BUDGET_EXCEEDED' | 'RATE_LIMITED' | 'FROZEN' | 'BROKER_ERROR'
  | 'BROKER_RESOURCE_LOCKED' | 'BROKER_PRECONDITION_FAILED' | 'BROKER_UNREACHABLE' | 'ENGINE_SHUTTING_DOWN'
  | 'TOKEN_EXPIRED' | 'TOKEN_TOO_LARGE' | 'EGRESS_DENIED' | 'TLS_UNTRUSTED' | 'SEMANTICS_GAP' | 'INTERNAL';
export interface GateDecision { enabled: boolean; mode?: 'full' | 'degraded'; reason?: string; source?: string; fix?: { actionId: ActionId; input: unknown } }
export interface WarningRef { id: WarningId; severity: 'info' | 'warn' | 'consent' | 'block'; textKey: string; textVersion: number }
export interface Problem { type: string; title: string; status: number; code: ErrorCode; detail?: string; correlationId: string;
  retryable: boolean; gate?: GateDecision; warnings?: WarningRef[]; missingPermission?: Permission;
  broker?: { protocol: 'http' | 'amqp091' | 'amqp10' | 'stream'; classId?: number; code?: number | string; text?: string } }

// Live protocol (identical on WebSocket and MessagePort)
export type ClientFrame =
  | { t: 'hello'; v: 1; resume?: { session: string; lastSeq: Record<number, number> } }
  | { t: 'sub'; sid: number; topic: TopicId; params: unknown; credit: number }
  | { t: 'credit'; sid: number; n: number } | { t: 'unsub'; sid: number } | { t: 'ping'; ts: number };
export type ServerFrame =
  | { t: 'welcome'; v: 1; session: string; engineVersion: string; limits: { maxSubs: 64; outboxBytes: number; maxFrameBytes: number } }
  | { t: 'subok'; sid: number; qos: Qos }
  | { t: 'data'; sid: number; seq: number; items: unknown[]; dropped?: number; sampledEvery?: number }
  | { t: 'snapshot'; sid: number; seq: number; items: unknown[] }
  | { t: 'delta'; sid: number; seq: number; upserts: unknown[]; removes: string[] }
  | { t: 'status'; sid: number; state: 'active' | 'paused' | 'degraded' | 'stale' }
  | { t: 'gap'; sid: number; fromSeq: number; toSeq: number; reason: 'overflow' | 'resume-unavailable' | 'engine-restart' }
  | { t: 'end'; sid: number; reason: 'unsub' | 'completed' | 'lease_expired' | 'error'; problem?: Problem }
  | { t: 'goaway'; reason: 'drain' | 'version-mismatch' | 'auth-expired'; reconnectAfterMs?: number } | { t: 'pong'; ts: number };
export type PortFrame =                                                 // desktop MessagePort envelope
  | { t: 'http.req'; id: number; method: string; url: string; headers: Record<string, string>; body?: string | ArrayBuffer }
  | { t: 'http.res'; id: number; status: number; headers: Record<string, string>; body?: string | ArrayBuffer; streamed?: boolean }
  | { t: 'http.chunk'; id: number; body: ArrayBuffer; last: boolean } | { t: 'http.abort'; id: number }
  | { t: 'live'; frame: ClientFrame | ServerFrame };

// =====================================================================================
// @app/domain-model — BrokerProfile (DC-31)
// =====================================================================================
export type Era = '3.13' | '4.0-4.2' | '4.3' | '4.4';
export type QueueType = 'classic' | 'quorum' | 'stream';
export interface SemVer { major: number; minor: number; patch: number; pre?: string; raw: string }
export type Verification = 'verified' | 'unverified-patch' | 'unverified-minor' | 'unknown-build';
export interface BrokerProfile {
  schemaVersion: 1; connectionId: ConnectionId; probedAt: number; fingerprint: string; semanticsVersion: string;
  product: 'rabbitmq' | 'tanzu-rabbitmq' | 'lavinmq' | 'apsaramq' | 'unknown';
  provider: 'self-hosted' | 'amazon-mq' | 'cloudamqp-shared' | 'cloudamqp-dedicated' | 'ibm' | 'k8s-operator' | 'bitnami' | 'unknown';
  versions: { min: SemVer | null; perNode: Record<string, SemVer | null>; mixed: boolean; build: 'oss' | 'commercial-or-unknown' };
  era: { value: Era; reasons: string[]; conservative: boolean }; verification: Verification;
  lbFronted: { value: boolean; evidence: string[] };
  nodes: Array<{ name: string; running: boolean; beingDrained?: boolean; enabledPlugins?: string[]; qqMachineVersion?: number }>;
  identity: { user: string; tags: string[]; isAdmin: boolean; canMonitor: boolean; isPolicymaker: boolean; protected?: boolean };
  featureFlags: Record<string, 'enabled' | 'disabled' | 'unavailable'>; deprecatedFeaturesUsed: string[];
  stats: { disabled: boolean; queueTotals: boolean }; defaultQueueType?: QueueType; classicEnabled: boolean | 'unknown';
  exchangeTypes: string[]; extensions: string[];
  restrictions: { operatorPolicyChanges: 'allowed' | 'disabled' | 'unknown'; qqReplicaOps: 'allowed' | 'disabled' | 'unknown'; definitionsExport: 'full' | 'synthetic' | 'none' };
  limits: { connectionMax?: number; channelMax?: number; consumersPerChannelMax?: number; maxMessageBytes?: number; frameMax?: number; preAuthFrameMax: 4096 | 8192 };
  prometheus: { endpoints: Array<{ node: string; url: string; source: 'provider' | 'listener' | 'default' | 'user' }>; perObjectAllowed: boolean; queueFilter: boolean; minIntervalSec: number };
  streams: { supported: boolean; paths: Array<'amqp10' | 'amqp091' | 'stream-protocol'>; streamProtocolReachable: boolean | 'unknown' };
  firehose: { available: 'tracing-plugin' | 'runbook-only' | 'none' };
  auth: { oauth?: { issuer: string; pinned: boolean; source: 'bootstrap.js' | 'api/auth' }; httpChainSeparate: boolean | 'unknown' };
  tls: { verified: boolean; notAfter?: number; insecureOverride: boolean };
  managedObjects: Array<{ kind: string; vhost?: string; name: string; managedBy: 'servicecontrol' | 'wolverine' | 'k8s-topology-operator' | 'provider' | 'nservicebus-policy' | 'other' }>;
  hazards: string[]; gates: Record<FeatureId, GateDecision>; allowedActions?: ActionId[];   // per principal, engine-computed
}

// =====================================================================================
// @app/semantics — registry (DC-01/02, ADR-007)
// =====================================================================================
export type SettleAction = 'amqp091.nack_requeue' | 'amqp091.reject_requeue' | 'amqp091.no_requeue' | 'amqp10.released'
  | 'amqp10.modified_df_false' | 'amqp10.modified_df_true' | 'amqp10.rejected' | 'close_while_holding' | 'tcp_loss'
  | 'partition' | 'amqp10.detach_unsettled' | 'consumer_timeout' | 'http.ack_requeue_true';
export type LimitState = 'unset' | 'finite' | 'minus1';
export type DeliveryLimit = { kind: 'unlimited' } | { kind: 'finite'; value: number } | { kind: 'unknown' };
export interface SettleEffect { deltaAC: 0 | 1; deltaDC: 0 | 1; countsTowardLimit: 'yes' | 'no' | 'if-dc-gt-limit' | 'if-limit-set';
  position: 'head' | 'tail' | 'original' | 'delayed' | 'dlx-or-drop' | 'removed'; destructive: boolean }
export interface SemanticsCell {
  id: CellId; key: { era: Era; queueType: QueueType; protocol: 'amqp091' | 'amqp10' | 'http'; action: SettleAction; limit?: LimitState; delayedRetry?: 'disabled' | 'all' | 'failed' | 'returned' };
  effect: SettleEffect; citations: Array<{ kind: 'S' | 'D' | 'RN' | 'GH' | 'M3' | 'LAB'; ref: string }>;
  conformance: ConformanceId[]; status: 'code-derived' | 'lab-verified' | 'lab-contradicted';
  evidence: string[];                                  // testing/lab-evidence/<ver>/<CF-id>.json (independent of registry)
}
export class SemanticsGapError extends Error { constructor(public readonly key: SemanticsCell['key']) { super('semantics gap'); } }
export interface EraInputs { nodeVersions: Array<SemVer | null>; ff43Enabled: boolean | 'unknown'; qqMachineVersions: number[]; build: 'oss' | 'commercial-or-unknown'; lastVerified: readonly string[] }
export interface BrokerSemanticsRegistry {
  readonly version: string;                                                    // 'sem-2026.10.1' -> receipts
  resolveEra(i: EraInputs): { era: Era; reasons: string[]; conservative: boolean; verification: Verification };
  cell(key: SemanticsCell['key']): SemanticsCell;                              // throws SemanticsGapError (fail closed)
  isDoomed(era: Era, c: { deliveryCount?: number; acquiredCount?: number }, limit: DeliveryLimit): boolean;
  warning(id: WarningId): WarningRef;
  hazards(p: Pick<BrokerProfile, 'versions' | 'stats' | 'featureFlags' | 'product'>): string[];
  capability(id: string, p: Pick<BrokerProfile, 'versions' | 'stats' | 'product'>): boolean;   // DC-32, e.g. 'channelsAcceptDisableStats'; throws SemanticsGapError for an unknown id
  gate(feature: FeatureId, p: BrokerProfile): GateDecision;
  peekCaps(era: Era, q: QueueType, role: 'user' | 'admin', v: Verification): { def: number; max: number; maxBytes: number };
  tapRule(exchangeType: string, version: SemVer | null): { diverts: boolean; e2eAllowed: boolean; refuseByDefault: boolean };
  providerPreset(t: Pick<BrokerProfile, 'provider' | 'product'>, version: SemVer | null): ResolvedPreset;   // limits, owned objects, support levels (j.1); a probe outranks it
}

// =====================================================================================
// @app/ports — Read/Write split, role-typed leases, settlement proofs (ADR-009)
// =====================================================================================
export interface ConfirmedCopyProof { readonly __proof: 'confirmed-copy'; readonly destination: string; readonly confirmedAt: number }
export interface DestructiveConsentProof { readonly __proof: 'destructive-consent'; readonly planHash: string }
export interface SafeReturnProof { readonly __proof: 'safe-return'; readonly reason: 'classic' | 'quorum-unlimited' }   // issued by planner only
export interface Delivery { tag: bigint; redelivered: boolean; exchange: string; routingKey: string; properties: Record<string, unknown>; headers: Readonly<Record<string, TypedHeaderValue>>; body: Uint8Array }
export type PublishOutcome = { outcome: 'confirmed'; proof: ConfirmedCopyProof } | { outcome: 'nacked' | 'returned' | 'blocked' | 'timeout'; reason?: string };
export interface PeekLease {                                  // role 'peek': never publishes
  get(queue: string): Promise<Delivery | null>;              // noAck=false; adapter asserts queue type != stream
  nackRequeue(upToTag: bigint, o: { multiple: true; requeue: true }): void;
  qosBarrier(prefetch: number): Promise<void>;               // synchronous basic.qos round trip (DC-04)
  ackWithProof(tag: bigint, p: ConfirmedCopyProof | DestructiveConsentProof): void;
  throwaway<T>(fn: (ch: { checkQueue(name: string): Promise<{ messageCount: number; consumerCount: number }> }) => Promise<T>): Promise<T>;
  release(state: 'healthy' | 'poisoned'): Promise<void>;     // lazy close after barrier
}
export interface SourceLease {                                // role 'source': replay/move consumers
  consume(queue: string, prefetch: number, onDelivery: (d: Delivery | null) => void): Promise<{ consumerTag: string }>;
  ackWithProof(tag: bigint, p: ConfirmedCopyProof | DestructiveConsentProof): void;
  nackRequeue(tag: bigint, p: SafeReturnProof): void;        // impossible to express for finite-L QQ sources
  qosBarrier(prefetch: number): Promise<void>; cancel(tag: string): Promise<void>; release(state: 'healthy' | 'poisoned'): Promise<void>;
}
export interface PublishLease {                               // role 'publish': confirm channels only
  publish(exchange: string, routingKey: string, body: Uint8Array, props: Record<string, unknown>, o: { mandatory: true; timeoutMs: number }): Promise<PublishOutcome>;
  readonly blocked: () => boolean; release(): Promise<void>;
}
export interface ObserveLease {
  declareTapQueue(spec: TapQueueSpec): Promise<void>; bindQueue(q: string, src: string, key: string, args: Record<string, unknown>): Promise<void>;
  unbindQueue(q: string, src: string, key: string, args: Record<string, unknown>): Promise<void>;
  consume(q: string, prefetch: number, on: (d: Delivery | null) => void): Promise<{ consumerTag: string }>;
  ackTap(tag: bigint, multiple: boolean): void; release(): Promise<void>;
}
export type ConnectionRole = 'control' | 'peek' | 'source' | 'publish' | 'observe';
export interface ConnectionManager {   // vhost added by the critique fix; budgets keyed by (connection, vhost, role); M0-43
  peek(c: ConnectionId, vhost: string, p: Principal, s: AbortSignal): Promise<PeekLease>;
  source(c: ConnectionId, vhost: string, p: Principal, s: AbortSignal): Promise<SourceLease>;
  publish(c: ConnectionId, vhost: string, p: Principal, s: AbortSignal): Promise<PublishLease>;
  observe(c: ConnectionId, vhost: string, p: Principal, s: AbortSignal): Promise<ObserveLease>;
  budget(c: ConnectionId, vhost: string): Array<{ role: ConnectionRole; vhost: string; inUse: number; max: number; queued: number; etaMs: number | null }>;
  usage(c: ConnectionId): { inUse: number; max: number; queued: number; brokerMax: number | null };   // "the tool uses X of Y connections" (A-10)
}
export interface MgmtReadPort {
  get<T>(r: { connectionId: ConnectionId; path: string; query?: Record<string, string | number | boolean>; schema: z.ZodType<T>; lane: 'interactive' | 'live' | 'background' }, s: AbortSignal): Promise<T>;
  stream(r: { connectionId: ConnectionId; path: string; query?: Record<string, string | number | boolean>; lane: 'interactive' | 'live' | 'background' }, s: AbortSignal): Promise<AsyncIterable<Uint8Array>>;
}
export interface MgmtWritePort { send<T>(r: { connectionId: ConnectionId; method: 'PUT' | 'POST' | 'DELETE'; path: string; body?: unknown; schema: z.ZodType<T> }, s: AbortSignal): Promise<T> }
export interface Amqp10Receiver { readonly appliedFilters: ReadonlyMap<string, unknown>; addCredit(n: 1 | number): void; drain(): Promise<void>;
  deliveries(): AsyncIterable<{ id: number; message: { annotations: Record<string, unknown>; properties: Record<string, unknown>; applicationProperties: Record<string, unknown>; body: Uint8Array }; deliveryCount?: number }>;
  release(id: number): void; accept(id: number, p: ConfirmedCopyProof | DestructiveConsentProof | { __proof: 'stream-credit' }): void; detach(): Promise<void> } // detach throws if unsettled
export interface DialerPort { check(t: { host: string; port: number; purpose: string }): Promise<{ allowed: boolean; reason?: string; resolved: string[] }>;
  connect(t: { host: string; port: number; servername?: string; purpose: string }, route: unknown, s?: AbortSignal): Promise<import('node:net').Socket>;
  forwarder(t: { host: string; port: number; purpose: string }, route: unknown): Promise<{ path: string; close(): Promise<void> }> }

// =====================================================================================
// Action layer (kernel) — ADR-006
// =====================================================================================
export interface Principal { kind: 'desktop-user' | 'local-token' | 'team-user' | 'api-token' | 'mcp-client' | 'job' | 'system';
  id: string; display: string; roles: string[]; surface: 'ui' | 'cli' | 'mcp' | 'job' | 'system'; unattended: boolean; onBehalfOf?: Principal }
export interface ActionContext { principal: Principal; mode: EngineMode; env: EnvClass; correlationId: string; signal: AbortSignal; deadline?: number; now(): number }
export interface Gate { id: string; blocking: boolean; reason: string; source?: string; fix?: { actionId: ActionId; input: unknown } }
export interface PlanDraft<P> { preview: P; gates: Gate[]; warnings: WarningRef[]; consentsRequired: string[]; sensitivePayload?: unknown }  // encrypted at rest
export interface Plan<I = unknown, P = unknown> { id: PlanId; actionId: ActionId; inputHash: string; principalId: string; profileFingerprint?: string;
  env: EnvClass; risk: Risk; gates: Gate[]; warnings: WarningRef[]; consentsRequired: string[]; confirmationPhrase?: string;
  approvals: { required: number; granted: Array<{ by: string; at: number; decision: 'approve' | 'reject' }> };
  preview: P; input: I; expiresAt: number; state: 'open' | 'awaiting-approval' | 'approved' | 'executing' | 'executed' | 'expired' | 'rejected' }
export interface SideEffectReceipt { id: ReceiptId; actionId: ActionId; planId?: PlanId; semanticsVersion: string; verification: Verification;
  confidence: 'code-derived' | 'lab-verified' | 'unverified-version'; startedAt: number; finishedAt: number; summary: string; effects: unknown; auditSeq?: bigint }
export interface ActionImpl<A extends ActionDef, P = unknown> {
  readonly def: A;
  plan?(input: InputOf<A>, ctx: ActionContext): Promise<PlanDraft<P>>;                  // reads only (tested with throwing WritePorts)
  revalidate?(plan: Plan<InputOf<A>, P>, ctx: ActionContext): Promise<'valid' | { stale: string }>;   // TOCTOU
  execute(input: InputOf<A>, ctx: ActionContext & { plan?: Plan<InputOf<A>, P>; consents: ReadonlySet<string> }): Promise<OutputOf<A> | { jobId: JobId }>;
}
export declare function implementAction<A extends ActionDef, P = unknown>(def: A, impl: Omit<ActionImpl<A, P>, 'def'>): ActionImpl<A, P>;
export interface GuardrailDecision { risk: Risk; planning: 'none' | 'optional' | 'required'; approvalsRequired: number; confirmationPhrase?: string;
  denied?: { code: ErrorCode; reason: string }; forbidLetBrokerHandle: boolean; extraConsents: string[] }
export interface ActionExecutor {
  run<A extends ActionDef>(def: A, input: unknown, ctx: ActionContext): Promise<OutputOf<A> | { planRequired: Plan } | { jobId: JobId }>;
  plan<A extends ActionDef>(def: A, input: unknown, ctx: ActionContext): Promise<Plan>;
  approve(planId: PlanId, approver: Principal, decision: 'approve' | 'reject', note?: string): Promise<Plan>;   // approver != requester
  execute(req: { planId: PlanId; consents: string[]; confirmation?: string; idempotencyKey: string }, ctx: ActionContext): Promise<{ output: unknown; receipt?: SideEffectReceipt } | { jobId: JobId }>;
  state(): 'accepting' | 'draining' | 'frozen-partial' | 'stopped';
}

// =====================================================================================
// Peek planner (pure) + executor — ADR-008, ADR-028
// =====================================================================================
export type Disposition = { kind: 'quarantine'; queue: string } | { kind: 'raise-limit'; policyName: string; value: number | -1 } | { kind: 'let-broker-handle'; typedConsent: string };
export interface PeekRequest { connectionId: ConnectionId; queue: ObjectKey; count: number; maxBytes?: number; disposition?: Disposition; prefer?: 'amqp091' | 'amqp10-step' | 'http-fallback' }
export interface RescuePreflight { queueReady: boolean; declaredType: 'classic' | 'quorum-unlimited'; policyMatches: string[]; overflowSafe: boolean; permissionOk: boolean; alarms: string[]; publishBlocked: boolean; checkedAt: number }
export interface PeekPreflight { queue: { type: QueueType; exclusiveOwnedByOther: boolean; autoDelete: boolean; deliveryLimit: DeliveryLimit; sacActive: boolean; consumers: number; ready?: number; quorumOk?: boolean;
    delayedRetry?: { type: 'disabled' | 'all' | 'failed' | 'returned'; minMs?: number; messagesDelayed?: number }; maxLength?: number; overflow?: string; ttlMs?: number; consumerTimeoutMs?: number; avgBytes?: number };
  dlxSources: Array<{ queue: string; limit: DeliveryLimit }>; rescue?: RescuePreflight; rttMs: number; takenAt: number }
export interface PeekPlanPreview { era: Era; verification: Verification; method: 'amqp091.get' | 'amqp091.consumer-sac' | 'amqp10.credit1-step' | 'http.get_fallback';
  caps: { count: number; bytes: number }; hold: { targetMs: number; hardAbortMs: number; derivedFrom: string[] };
  guard: { counter: 'x-delivery-count' | 'x-acquired-count'; doomedWhen: '>' | '>='; limit: DeliveryLimit; stopAtFirstDoomed: true };
  disposition: Disposition; expected: Array<{ cell: CellId; effect: SettleEffect }>; honestLabel: string }
export type PlanRejection = { rejected: true; code: 'EXCLUSIVE' | 'OVERLIMIT_DLQ' | 'SAC_ACTIVE' | 'NO_QUORUM' | 'LIMIT_MINUS1_313' | 'NO_SAFE_DISPOSITION' | 'RESCUE_PREFLIGHT_FAILED' | 'SEMANTICS_GAP' | 'GATE'; reason: string };
export interface PeekPlanner { plan(req: PeekRequest, f: { profile: BrokerProfile; preflight: PeekPreflight; principal: Principal; registry: BrokerSemanticsRegistry; env: EnvClass }): PlanDraft<PeekPlanPreview> | PlanRejection }
export type CounterSource = 'broker-stamped' | 'dlx-carryover' | 'unverified-copied' | 'absent';
export type PeekState = 'idle' | 'preflighted' | 'acquiring' | 'guarding' | 'rescuing' | 'raising' | 'returning' | 'settled' | 'incident';
export interface PeekReceipt extends SideEffectReceipt { era: Era; method: PeekPlanPreview['method']; holdMs: number;
  returnPath: 'nack+barrier' | 'released+drain' | 'server-side' | 'channel-down' | 'queue-deleted';
  perMessage: Array<{ position: number; cell: CellId; deltaAC: 0 | 1; deltaDC: 0 | 1; newPosition: SettleEffect['position']; counterSource: CounterSource;
    outcome: 'requeued' | 'quarantined' | 'raised-limit-then-requeued' | 'broker-handled' | 'rescue-failed' | 'rescue-aborted' }>;
  stoppedBy: 'count' | 'bytes' | 'target' | 'empty' | 'guard' | 'watchdog' | 'abort' | 'broker-error'; anomalies: string[] }
export interface PeekExecutor {
  execute(plan: Plan<PeekRequest, PeekPlanPreview>, ctx: ActionContext): Promise<{ captureId: string; copies: Array<{ ref: string; seq: number; counters: { deliveryCount?: number; acquiredCount?: number; redelivered: boolean; source: CounterSource } }>; receipt: PeekReceipt }>;
  flushAll(reason: 'shutdown' | 'suspend' | 'cancel' | 'emergency'): Promise<{ flushed: number; failed: number }>;
  reconcileInterrupted(): Promise<PeekReceipt[]>;                                          // hold_journal -> W-CRASH receipts
}

// =====================================================================================
// Tap planner + replay planner/journal — ADR-010, ADR-011
// =====================================================================================
export interface TapQueueSpec { name: `${string}.tap.${string}`; exclusive: true; autoDelete: true; durable: false;
  args: { 'x-queue-type': 'classic'; 'x-max-length': number; 'x-overflow': 'drop-head'; 'x-message-ttl': number; 'x-expires': number; [k: `x-${string}-session`]: string } }
export interface TapPlan { mode: 'copied-binding' | 'e2e' | 'firehose'; queue: TapQueueSpec; bindings: Array<{ source: string; key: string; args: Record<string, unknown> }>;
  matchedPolicies: string[]; badges: Array<'default-exchange-blind' | 'ae-masking' | 'mandatory-masking' | 'unroutable-metric-masking' | 'partial-node-local' | 'diversion'>;
  consumer: { prefetch: number; ackEveryN: number; ackEveryMs: number }; leaseMs: number; churnCost: number }
export interface TapPlanner { plan(req: { connectionId: ConnectionId; target: { kind: 'queue' | 'exchange'; key: ObjectKey }; mode?: TapPlan['mode']; acceptDiversion?: boolean },
  f: { profile: BrokerProfile; topology: unknown; alarms: string[]; principal: Principal; registry: BrokerSemanticsRegistry; churnRemaining: number }): PlanDraft<TapPlan> | PlanRejection }
export interface ReplayPlanPreview { destination: { kind: 'queue'; queue: string } | { kind: 'exchange'; exchange: string; routingKey: string; fanOutConfirmed: true };
  resolution: 'framework-field' | 'x-death-newest' | 'naming-convention' | 'x-original' | 'user-mapping';
  source: { queue: string; type: QueueType; limit: DeliveryLimit; prefetch: 1 | number; returnable: boolean }; stripHeaders: string[]; stampHeaders: Record<string, string>;
  rate: { perSec: number; canary: number; observeMs: number }; parkQueue: string; dryRunSample: unknown[] }
export type JournalState = 'consumed' | 'published' | 'confirmed' | 'acked' | 'parked' | 'returned' | 'uncertain-duplicate' | 'error';
export interface ReplayJournalEntry { jobId: JobId; occurrenceKey: string; ordinal: number; logicalId?: string; fingerprint: string; state: JournalState; publishSeq?: number; replayId: string; at: number; copyRef?: string }
export interface ReplayJournal { append(e: ReplayJournalEntry): Promise<void>;
  counts(key: string): Promise<{ consumed: number; published: number; acked: number; parked: number }>;   // multiset per key
  decideOnRedelivery(key: string, headers: Record<string, unknown>): Promise<'ack-without-republish' | 'republish'> }  // when in doubt: republish

// =====================================================================================
// Jobs — ADR-015
// =====================================================================================
export type JobEvent = { kind: 'progress'; done: number; total?: number; note?: string } | { kind: 'warning'; warning: WarningRef } | { kind: 'paused'; reason: string } | { kind: 'checkpoint' };
export interface JobContext<I, C> { jobId: JobId; input: I; checkpoint?: C; principal: Principal; signal: AbortSignal; save(c: C): Promise<void>; journal: ReplayJournal;
  throttle: { take(n?: number, s?: AbortSignal): Promise<void> }; leases: ConnectionManager; executorWrite: unknown }
export interface JobDef<I, C, O> { type: string; version: number; input: z.ZodType<I>; checkpoint: z.ZodType<C>; output: z.ZodType<O>; resumable: boolean;
  concurrencyKey?(i: I): string; run(ctx: JobContext<I, C>): AsyncGenerator<JobEvent, O, void>;
  onDrain(ctx: JobContext<I, C>, reason: 'cancel' | 'shutdown' | 'suspend' | 'emergency', deadlineMs: number): Promise<void> }   // MUST park/flush holds
export interface JobRecord { id: JobId; type: string; state: 'queued' | 'running' | 'paused' | 'paused-interrupted' | 'awaiting-credentials' | 'succeeded' | 'failed' | 'cancelled';
  principal: Principal; planHash?: string; idempotencyKey: string; leaseOwner?: string; leaseUntil?: number; attempts: number; checkpoint?: unknown }
export interface JobStore { create(r: Omit<JobRecord, 'id' | 'state' | 'attempts'>): Promise<JobId>;
  claim(owner: string, leaseMs: number, types: readonly string[]): Promise<JobRecord | undefined>;      // FOR UPDATE SKIP LOCKED on pg
  heartbeat(id: JobId, owner: string, leaseMs: number): Promise<boolean>; saveCheckpoint(id: JobId, c: unknown): Promise<void>;
  setState(id: JobId, s: JobRecord['state'], reason?: string): Promise<void> }
export interface JobRunner { register(d: JobDef<any, any, any>): void; submit<I>(type: string, input: I, p: Principal, o: { idempotencyKey: string; planHash: string }): Promise<JobId>;
  command(id: JobId, c: 'pause' | 'resume' | 'cancel', p: Principal): Promise<void>; drain(reason: 'shutdown' | 'suspend' | 'emergency', deadlineMs: number): Promise<void> }

// =====================================================================================
// Engine lifecycle + transport
// =====================================================================================
export interface DrainPhase { name: 'gate' | 'peeks' | 'sources-jobs' | 'taps-firehose' | 'flush'; budgetMs: number; run(deadline: number): Promise<void> }
export interface DrainCoordinator { drain(reason: 'quit' | 'sigterm' | 'suspend' | 'emergency', totalMs: number): Promise<{ phase: string; ms: number; ok: boolean }[]> }
export type CtlFrame =                                           // zod-validated main <-> engine
  | { t: 'init'; paths: { data: string; logs: string }; dek?: Uint8Array; settings: unknown } | { t: 'ready'; contract: string; schemaHash: string }
  | { t: 'attach'; windowId: number } | { t: 'shutdown'; deadlineMs: number } | { t: 'suspend'; deadlineMs: number } | { t: 'resume' }
  | { t: 'notify'; title: string; body: string } | { t: 'save'; fileToken: string; artifactId: string };
export interface MessagePortLike { postMessage(m: PortFrame, transfer?: ArrayBuffer[]): void; on(e: 'message', f: (ev: { data: PortFrame }) => void): void; on(e: 'close', f: () => void): void; start(): void }
export interface PortSessionServer { attach(port: MessagePortLike, windowId: number): () => void }   // strips headers, adds carrier secret, inject(payloadAsStream)
export interface IpcHandshake { serverProof(nonceC: Uint8Array): { nonceS: Uint8Array; macS: Uint8Array }; verifyClient(nonceS: Uint8Array, nonceC: Uint8Array, macC: Uint8Array, tokenId: string): Promise<Principal | null> }
export interface EngineModule { id: string; actions: ActionImpl<any, any>[]; topics?: unknown[]; jobs?: JobDef<any, any, any>[];
  onStart?(): Promise<void>; drainPhases?(): DrainPhase[]; onSuspend?(): Promise<void>; onResume?(): Promise<void> }

// UI side (Angular)
export interface EngineTransport { readonly kind: 'messageport' | 'http'; request(r: { method: string; url: string; headers: Record<string, string>; body?: string | ArrayBuffer }, s?: AbortSignal): Promise<{ status: number; headers: Record<string, string>; body?: string | ArrayBuffer }>;
  openLive(): { send(f: ClientFrame): void; frames(): AsyncIterable<ServerFrame>; close(): void } }
export interface PlatformBridge { readonly kind: 'desktop' | 'web'; readonly bridgeVersion: 1; requestEnginePort?(): void;
  pickSaveTarget(o: { suggestedName: string }): Promise<{ fileToken: string } | null>; openExternal(url: string): Promise<'opened' | 'blocked' | 'cancelled'>;
  notify(n: { title: string; body: string }): Promise<void>; setMenu(m: unknown): void; onMenuCommand(f: (id: string) => void): () => void; appInfo(): Promise<{ version: string; mode: EngineMode }> }
//   EngineApi.call<A extends ActionDef>(a: A, input: InputOf<A>): Observable<OutputOf<A>>
//   engineResource<A extends ActionDef>(a: A, input: () => InputOf<A> | undefined): HttpResourceRef<OutputOf<A> | undefined>
//   { provide: HttpBackend, useExisting: MessagePortHttpBackend }   // desktop

// =====================================================================================
// Plugin SDK (DC-53) — apiVersion 1
// =====================================================================================
export type TypedHeaderValue = { t: 'string' | 'long' | 'int' | 'short' | 'byte' | 'double' | 'float' | 'bool' | 'timestamp' | 'decimal' | 'bytes' | 'void'; v: unknown } | { t: 'array'; v: TypedHeaderValue[] } | { t: 'table'; v: Record<string, TypedHeaderValue> };
export interface DecodeInput { headers: Readonly<Record<string, TypedHeaderValue>>; properties: Readonly<Record<string, unknown>>; body: Uint8Array; bodyTruncated: boolean; queue?: string; protocol: 'amqp091' | 'amqp10'; era: Era }
export interface NormalizedFailure { framework: string; messageId?: string; logicalIds: Record<string, string>; exception?: { type?: string; message?: string; frames?: string[] };
  deaths: Array<{ queue: string; reason: 'rejected' | 'expired' | 'maxlen' | 'delivery_limit'; count: number; scheduledNotFailed?: boolean }>; infrastructure?: 'delay' | 'retry' | 'none' }
export interface DecoderPlugin { apiVersion: 1; id: string; tier: 'builtin' | 'declarative' | 'sandboxed'; frameworks: readonly string[];
  detect(m: DecodeInput): number; decode(m: DecodeInput): NormalizedFailure; fingerprint(f: NormalizedFailure, level: 'type' | 'type+frame' | 'type+frame+template'): string;
  replayPlan(f: NormalizedFailure, ctx: { knownQueues: ReadonlySet<string> }): { destinationQueue?: string; stripHeaders: string[]; preserveIds: string[]; confidence: number } | null }
export interface CodecPlugin { apiVersion: 1; id: string; detect(m: DecodeInput): number; decode(m: DecodeInput): { kind: 'json' | 'text' | 'tree' | 'binary'; value: unknown }; encode?(v: unknown): Uint8Array }
```
