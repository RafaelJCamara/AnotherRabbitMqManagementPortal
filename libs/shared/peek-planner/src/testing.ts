// Builders for the specs. Not part of the public API (not exported from index.ts). The registry
// the specs use is the real one: the planner must agree with the data it ships with.
import { ConnectionIdSchema, encodeObjectKey } from '@app/contracts';
import type { Era, Verification } from '@app/domain-model';
import { semanticsRegistry } from '@app/semantics';
import texts from '../i18n/en/peek-planner.json' with { type: 'json' };
import { TEXT_SCOPE } from './rejections.ts';
import type {
  PeekFacts,
  PeekPreflight,
  PeekPrincipal,
  PeekProfile,
  PeekRequest,
  PreflightQueue,
  RescueFacts,
} from './types.ts';

export const NOW = 1_800_000_000_000;

export const human: PeekPrincipal = {
  kind: 'desktop-user',
  surface: 'ui',
  unattended: false,
};
export const unattended: PeekPrincipal = {
  kind: 'job',
  surface: 'job',
  unattended: true,
};
export const mcpClient: PeekPrincipal = {
  kind: 'mcp-client',
  surface: 'mcp',
  unattended: false,
};

export interface ProfileOptions {
  readonly verification?: Verification;
  readonly conservative?: boolean;
  readonly admin?: boolean;
  readonly mixed?: boolean;
  readonly managedPolicies?: readonly string[];
}

export function profileOf(era: Era, options: ProfileOptions = {}): PeekProfile {
  return {
    era: {
      value: era,
      reasons: [],
      conservative: options.conservative ?? false,
    },
    verification: options.verification ?? 'verified',
    versions: {
      min: null,
      perNode: {},
      mixed: options.mixed ?? false,
      build: 'oss',
    },
    identity: {
      user: 'tester',
      tags: [],
      isAdmin: options.admin ?? false,
      canMonitor: true,
      isPolicymaker: options.admin ?? false,
    },
    managedObjects: (options.managedPolicies ?? []).map((name) => ({
      kind: 'policy',
      name,
      managedBy: 'provider' as const,
    })),
    gates: {},
  };
}

/** A healthy quorum queue with a finite limit of 20 and nothing else going on. */
export function queueOf(
  overrides: Partial<PreflightQueue> = {},
): PreflightQueue {
  return {
    type: 'quorum',
    exclusiveOwnedByOther: false,
    autoDelete: false,
    deliveryLimit: { kind: 'finite', value: 20 },
    limitState: 'finite',
    singleActiveConsumer: false,
    hasActiveConsumer: false,
    consumers: 0,
    ready: 100,
    quorumOk: true,
    avgBytes: 1000,
    ...overrides,
  };
}

export function classicQueue(
  overrides: Partial<PreflightQueue> = {},
): PreflightQueue {
  return queueOf({
    type: 'classic',
    deliveryLimit: { kind: 'unlimited' },
    limitState: 'unset',
    quorumOk: undefined,
    ...overrides,
  });
}

export const rescueOf = (
  overrides: Partial<RescueFacts> = {},
): RescueFacts => ({
  queueName: 'app.quarantine',
  queueReady: true,
  overflowSafe: true,
  permissionOk: true,
  alarms: [],
  publishBlocked: false,
  checkedAt: NOW - 1_000,
  ...overrides,
});

export function preflightOf(
  queue: PreflightQueue = queueOf(),
  overrides: Partial<Omit<PeekPreflight, 'queue'>> = {},
): PeekPreflight {
  return {
    queue,
    dlxSources: { sources: [], complete: true, unknownReasons: [] },
    heldDeathSources: [],
    rescue: rescueOf(),
    rttMs: 5,
    takenAt: NOW - 1_000,
    ...overrides,
  };
}

export function requestOf(overrides: Partial<PeekRequest> = {}): PeekRequest {
  return {
    connectionId: ConnectionIdSchema.parse('lab'),
    queue: encodeObjectKey('/', 'orders.dlq'),
    count: 20,
    ...overrides,
  };
}

export function factsOf(
  era: Era,
  preflight: PeekPreflight = preflightOf(),
  overrides: Partial<Omit<PeekFacts, 'profile' | 'preflight'>> & {
    readonly profile?: PeekProfile;
  } = {},
): PeekFacts {
  const { profile, ...rest } = overrides;
  return {
    profile: profile ?? profileOf(era),
    preflight,
    principal: human,
    registry: semanticsRegistry,
    env: 'dev',
    nowMs: NOW,
    ...rest,
  };
}

/** Freezes a value and everything reachable from it, to prove that nothing mutates the input. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Resolves `peek-planner.a.b.v1` in the translation file, or undefined. */
export function lookup(key: string): string | undefined {
  const [scope, ...path] = key.split('.');
  if (scope !== TEXT_SCOPE) return undefined;
  let node: unknown = texts;
  for (const segment of path) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === 'string' ? node : undefined;
}

export interface Scenario {
  readonly name: string;
  readonly era: Era;
  readonly queue: PreflightQueue;
  readonly principal?: PeekPrincipal;
  readonly request?: Partial<PeekRequest>;
  readonly sources?: {
    queue: string;
    limit: { kind: 'finite'; value: number };
  }[];
}

/** One scenario for each kind of answer: plans, consents, every family of rejection. */
export const SCENARIOS: readonly Scenario[] = [
  { name: '4.0-4.2 budget', era: '4.0-4.2', queue: queueOf({ ttlMs: 60_000 }) },
  {
    name: '3.13 unset',
    era: '3.13',
    queue: queueOf({
      deliveryLimit: { kind: 'unlimited' },
      limitState: 'unset',
    }),
  },
  {
    name: '3.13 minus1',
    era: '3.13',
    queue: queueOf({
      deliveryLimit: { kind: 'unlimited' },
      limitState: 'minus1',
    }),
  },
  {
    name: '4.3 delayed',
    era: '4.3',
    queue: queueOf({ delayedRetry: { type: 'all' } }),
  },
  {
    name: '4.3 overlimit',
    era: '4.3',
    queue: queueOf({ delayedRetry: { type: 'disabled' } }),
    sources: [{ queue: 'a', limit: { kind: 'finite', value: 20 } }],
  },
  { name: '4.4 gap', era: '4.4', queue: queueOf() },
  { name: 'classic', era: '4.3', queue: classicQueue() },
  { name: 'stream', era: '4.3', queue: queueOf({ type: 'stream' }) },
  {
    name: 'ai quarantine',
    era: '4.0-4.2',
    queue: queueOf(),
    principal: mcpClient,
  },
  {
    name: 'unattended unknown',
    era: '4.3',
    queue: queueOf({ deliveryLimit: { kind: 'unknown' } }),
    principal: unattended,
  },
  {
    name: 'http fallback',
    era: '4.3',
    queue: classicQueue(),
    request: { prefer: 'http-fallback' },
  },
  {
    name: 'let broker',
    era: '4.0-4.2',
    queue: queueOf(),
    request: {
      disposition: { kind: 'let-broker-handle', typedConsent: 'orders.dlq' },
    },
  },
];

export function build(
  scenario: Scenario,
  nowMs = NOW,
): { request: PeekRequest; facts: PeekFacts } {
  const preflight = preflightOf(scenario.queue, {
    dlxSources: {
      sources: scenario.sources ?? [],
      complete: true,
      unknownReasons: [],
    },
    rescue: rescueOf(),
  });
  return {
    request: requestOf(scenario.request),
    facts: factsOf(scenario.era, preflight, {
      profile: profileOf(scenario.era),
      principal: scenario.principal ?? human,
      nowMs,
    }),
  };
}
