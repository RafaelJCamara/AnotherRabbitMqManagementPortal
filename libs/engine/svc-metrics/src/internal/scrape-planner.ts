// The ScrapePlanner (blueprint section 8, DC-33, ADR-024): pure. From the BrokerProfile, the queues
// somebody wants to watch and what earlier scrapes cost, it decides which endpoints are scraped, which
// requests each gets, how often, and whether the management API is read instead. It reads facts from
// the profile (the listeners the probe found, the provider's minimum interval, whether `queue=` is
// allowed, whether per-object metrics are) and never compares a version or names a provider (I-3).
//
//  - every node is scraped directly, never through a Service or a balancer; a profile whose nodes
//    outnumber its endpoints is `partial`, with the reason;
//  - the aggregated `/metrics` is always scraped; `/metrics/detailed` only for demanded queues and
//    only where per-object metrics are allowed (Amazon MQ: never); `queue=` only where the registry
//    says the broker accepts it, in chunks of at most `maxQueryRegexChars` characters;
//  - the interval is at least the provider's minimum, the base interval and `costFactor` times the
//    last scrape duration of the target.
import type { BrokerProfile } from '@app/domain-model';
import type { PromQuery } from '@app/ports';

import type { MetricsLimits } from '../deps';
import type { PARTIAL_REASONS } from '@app/contracts';

import { DETAILED_FAMILIES } from './catalog';

export type PartialReason = (typeof PARTIAL_REASONS)[number];

export interface QueueDemand {
  readonly vhost: string;
  readonly name: string;
}

export interface TargetHistory {
  /** How long the last successful scrape of the target took. */
  readonly lastDurationMs?: number;
}

export interface PlanInput {
  readonly profile: Pick<BrokerProfile, 'prometheus' | 'lbFronted' | 'nodes'>;
  readonly queues: readonly QueueDemand[];
  /** By target id (`targetId`) and `management` for the fallback. */
  readonly history: ReadonlyMap<string, TargetHistory>;
  /** The collector's verdict: Prometheus is failing, read the management API for now. */
  readonly fallback: boolean;
  readonly limits: MetricsLimits;
}

export interface ScrapeStep {
  readonly kind: 'aggregated' | 'detailed';
  readonly path: `/${string}`;
  readonly query?: PromQuery;
}

export type PlanNote =
  | 'per-object-not-allowed'
  | 'unfiltered-detailed'
  | 'queue-demand-truncated'
  | 'vhosts-truncated';

export interface ScrapeTarget {
  readonly id: string;
  readonly node: string;
  readonly endpoint: string;
  readonly source: BrokerProfile['prometheus']['endpoints'][number]['source'];
  /** Whether the connection's own login goes with the request (OQ-864). */
  readonly login: 'connection' | 'none';
  readonly intervalMs: number;
  readonly steps: readonly ScrapeStep[];
}

export interface PrometheusPlan {
  readonly source: 'prometheus';
  readonly targets: readonly ScrapeTarget[];
  readonly partial: readonly PartialReason[];
  /** Profile nodes no endpoint is known to cover; empty when only the counts differ. */
  readonly uncoveredNodes: readonly string[];
  readonly notes: readonly PlanNote[];
  /** The slowest target's interval: the cadence a status reports. */
  readonly intervalMs: number;
}

export interface ManagementPlan {
  readonly source: 'management';
  readonly reason: 'no-endpoint' | 'failing';
  readonly intervalMs: number;
  /** `/api/overview` and `/api/nodes`: aggregate reads, never one object at a time. */
  readonly reads: readonly ['overview', 'nodes'];
  /** Single-queue reads, only where per-object requests are allowed. */
  readonly queues: readonly QueueDemand[];
  readonly partial: readonly PartialReason[];
  readonly notes: readonly PlanNote[];
}

export type ScrapePlan = PrometheusPlan | ManagementPlan;

export const targetId = (node: string, endpoint: string): string =>
  `${node}|${endpoint}`;

const MANAGEMENT_ID = 'management';
export const MANAGEMENT_HISTORY_KEY = MANAGEMENT_ID;

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;
const escapeRegex = (text: string): string =>
  text.replace(REGEX_SPECIALS, '\\$&');

function dedupe(
  queues: readonly QueueDemand[],
  max: number,
): { kept: QueueDemand[]; truncated: boolean } {
  const seen = new Set<string>();
  const kept: QueueDemand[] = [];
  let truncated = false;
  for (const queue of queues) {
    const key = `${queue.vhost}\u0000${queue.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (kept.length >= max) truncated = true;
    else kept.push(queue);
  }
  return { kept, truncated };
}

/** `^(?:a|b)$` chunks of at most `max` characters, one list of names per vhost. */
function regexChunks(names: readonly string[], max: number): string[] {
  const wrapper = '^(?:)$'.length;
  const chunks: string[] = [];
  let current: string[] = [];
  let length = wrapper;
  for (const name of [...names].sort()) {
    const escaped = escapeRegex(name);
    if (current.length > 0 && length + 1 + escaped.length > max) {
      chunks.push(`^(?:${current.join('|')})$`);
      current = [];
      length = wrapper;
    }
    length += (current.length === 0 ? 0 : 1) + escaped.length;
    current.push(escaped);
  }
  if (current.length > 0) chunks.push(`^(?:${current.join('|')})$`);
  return chunks;
}
function intervalFor(
  limits: MetricsLimits,
  baseMs: number,
  providerMinMs: number,
  lastDurationMs: number | undefined,
): number {
  const cost = (lastDurationMs ?? 0) * limits.costFactor;
  const wanted = Math.max(baseMs, providerMinMs, cost);
  // The cap never goes below what the provider documents.
  return Math.max(providerMinMs, Math.min(limits.maxIntervalMs, wanted));
}

function detailedSteps(
  queues: readonly QueueDemand[],
  profile: PlanInput['profile'],
  limits: MetricsLimits,
  notes: Set<PlanNote>,
): ScrapeStep[] {
  const byVhost = new Map<string, string[]>();
  for (const queue of queues) {
    const names = byVhost.get(queue.vhost) ?? [];
    names.push(queue.name);
    byVhost.set(queue.vhost, names);
  }
  const steps: ScrapeStep[] = [];
  const family = [...DETAILED_FAMILIES];
  const filtered = profile.prometheus.queueFilter;
  if (!filtered) notes.add('unfiltered-detailed');
  for (const [vhost, names] of [...byVhost].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    const requests: PromQuery[] = filtered
      ? regexChunks(names, limits.maxQueryRegexChars).map((queue) => ({
          family,
          vhost,
          queue,
        }))
      : [{ family, vhost }];
    for (const query of requests) {
      if (
        steps.length >=
        (filtered ? limits.maxDetailedRequests : limits.maxDetailedVhosts)
      ) {
        notes.add(filtered ? 'queue-demand-truncated' : 'vhosts-truncated');
      } else {
        steps.push({ kind: 'detailed', path: '/metrics/detailed', query });
      }
    }
  }
  return steps;
}

export function planScrape(input: PlanInput): ScrapePlan {
  const { profile, limits } = input;
  const { kept: queues, truncated } = dedupe(
    input.queues,
    limits.maxPinnedQueues,
  );
  const notes = new Set<PlanNote>();
  if (truncated) notes.add('queue-demand-truncated');
  const providerMinMs = Math.max(0, profile.prometheus.minIntervalSec) * 1000;
  const perObject = profile.prometheus.perObjectAllowed;
  const wantsQueues = queues.length > 0;

  const endpoints = profile.prometheus.endpoints;
  if (endpoints.length === 0 || input.fallback) {
    // Per-object reads only where the provider allows them (Amazon MQ never sees one).
    if (wantsQueues && !perObject) notes.add('per-object-not-allowed');
    const partial: PartialReason[] = ['fallback'];
    if (wantsQueues && !perObject) partial.push('per-object-unavailable');
    return {
      source: 'management',
      reason: endpoints.length === 0 ? 'no-endpoint' : 'failing',
      intervalMs: intervalFor(
        limits,
        limits.mgmtBaseIntervalMs,
        providerMinMs,
        input.history.get(MANAGEMENT_ID)?.lastDurationMs,
      ),
      reads: ['overview', 'nodes'],
      queues: perObject ? queues.slice(0, limits.maxMgmtQueueReads) : [],
      partial,
      notes: [...notes],
    };
  }

  const steps: ScrapeStep[] = [{ kind: 'aggregated', path: '/metrics' }];
  if (wantsQueues && !perObject) notes.add('per-object-not-allowed');
  if (wantsQueues && perObject) {
    steps.push(...detailedSteps(queues, profile, limits, notes));
  }

  const targets: ScrapeTarget[] = endpoints.map((endpoint) => {
    const id = targetId(endpoint.node, endpoint.url);
    return {
      id,
      node: endpoint.node,
      endpoint: endpoint.url,
      source: endpoint.source,
      login: endpoint.source === 'provider' ? 'connection' : 'none',
      intervalMs: intervalFor(
        limits,
        limits.baseIntervalMs,
        providerMinMs,
        input.history.get(id)?.lastDurationMs,
      ),
      steps,
    };
  });

  // Coverage: every node of the cluster needs its own listener, whatever name the endpoint carries
  // (Amazon MQ lists three ports under one name).
  const expected = Math.max(1, profile.nodes.length);
  const partial: PartialReason[] = [];
  let uncoveredNodes: string[] = [];
  if (targets.length < expected) {
    partial.push(
      profile.lbFronted.value
        ? 'load-balancer-fronted'
        : 'nodes-without-endpoint',
    );
    const covered = new Set(targets.map((target) => target.node));
    uncoveredNodes = profile.nodes
      .map((node) => node.name)
      .filter((name) => !covered.has(name));
  }
  if (wantsQueues && !perObject) partial.push('per-object-unavailable');
  if (notes.has('queue-demand-truncated') || notes.has('vhosts-truncated')) {
    partial.push('queue-demand-truncated');
  }
  return {
    source: 'prometheus',
    targets,
    partial,
    uncoveredNodes,
    notes: [...notes],
    intervalMs: Math.max(...targets.map((target) => target.intervalMs)),
  };
}
