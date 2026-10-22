import { describe, expect, it } from 'vitest';

import { semanticsRegistry } from '@app/semantics';

import { DEFAULT_METRICS_LIMITS } from '../deps';
import {
  planScrape,
  targetId,
  type PlanInput,
  type PrometheusPlan,
  type QueueDemand,
  type ScrapePlan,
} from './scrape-planner';

type Profile = PlanInput['profile'];
type Endpoint = Profile['prometheus']['endpoints'][number];

const nodeNames = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `rabbit@n${String(i + 1)}`);

function profileOf(
  options: {
    endpoints?: Endpoint[];
    nodes?: string[];
    lb?: boolean;
    perObject?: boolean;
    queueFilter?: boolean;
    minIntervalSec?: number;
  } = {},
): Profile {
  return {
    prometheus: {
      endpoints: options.endpoints ?? [],
      perObjectAllowed: options.perObject ?? true,
      queueFilter: options.queueFilter ?? true,
      minIntervalSec: options.minIntervalSec ?? 15,
    },
    lbFronted: { value: options.lb ?? false, evidence: [] },
    nodes: (options.nodes ?? nodeNames(1)).map((name) => ({
      name,
      running: true,
    })),
  };
}

const listener = (node: string, port = 15692): Endpoint => ({
  node,
  url: `http://broker.example:${String(port)}/metrics`,
  source: 'listener',
});

const queues = (count: number, vhost = '/', prefix = 'queue.'): QueueDemand[] =>
  Array.from({ length: count }, (_, i) => ({
    vhost,
    name: `${prefix}${String(i).padStart(4, '0')}`,
  }));

function plan(profile: Profile, over: Partial<PlanInput> = {}): ScrapePlan {
  return planScrape({
    profile,
    queues: [],
    history: new Map(),
    fallback: false,
    limits: DEFAULT_METRICS_LIMITS,
    ...over,
  });
}

function prom(result: ScrapePlan): PrometheusPlan {
  if (result.source !== 'prometheus')
    throw new Error('expected a Prometheus plan');
  return result;
}

describe('planScrape: providers', () => {
  it('AC-10 an Amazon MQ profile gets one target per port, at 60 s or slower, with no per-object request', () => {
    // The ports and the interval come from the registry's provider preset, as the probe stores them.
    const preset = semanticsRegistry.providerPreset(
      { provider: 'amazon-mq', product: 'rabbitmq' },
      null,
    );
    expect(preset.prometheus.ports).toEqual([16001, 16002, 16003]);
    const host = 'b-1234.mq.eu-west-1.on.aws';
    const profile = profileOf({
      endpoints: (preset.prometheus.ports ?? []).map((port) => ({
        node: 'rabbit@answering',
        url: `https://${host}:${String(port)}/metrics`,
        source: 'provider' as const,
      })),
      nodes: nodeNames(3),
      perObject: preset.prometheus.perObjectAllowed ?? false,
      minIntervalSec: preset.prometheus.minIntervalSec ?? 15,
    });
    const result = prom(plan(profile, { queues: queues(40) }));

    expect(result.targets.map((target) => target.endpoint)).toEqual([
      `https://${host}:16001/metrics`,
      `https://${host}:16002/metrics`,
      `https://${host}:16003/metrics`,
    ]);
    // Three listeners for three nodes: covered, though they share one name.
    expect(result.partial).toEqual(['per-object-unavailable']);
    for (const target of result.targets) {
      expect(target.intervalMs).toBeGreaterThanOrEqual(60_000);
      expect(target.login).toBe('connection');
      // The aggregated page only: never a per-object request, whatever was asked for.
      expect(target.steps).toEqual([{ kind: 'aggregated', path: '/metrics' }]);
    }
    expect(result.notes).toContain('per-object-not-allowed');
    expect(new Set(result.targets.map((target) => target.id)).size).toBe(3);
  });

  it('AC-10 the login goes only to provider endpoints', () => {
    const result = prom(
      plan(
        profileOf({
          endpoints: [
            listener('rabbit@n1'),
            { node: 'rabbit@n1', url: 'http://h:1/metrics', source: 'default' },
            { node: 'rabbit@n1', url: 'http://h:2/metrics', source: 'user' },
            {
              node: 'rabbit@n1',
              url: 'http://h:3/metrics',
              source: 'provider',
            },
          ],
        }),
      ),
    );
    expect(result.targets.map((target) => target.login)).toEqual([
      'none',
      'none',
      'none',
      'connection',
    ]);
  });
});

describe('planScrape: load balancers and coverage', () => {
  it('AC-11 an LB-fronted cluster uses per-node targets when it has them', () => {
    const profile = profileOf({
      lb: true,
      nodes: nodeNames(3),
      endpoints: nodeNames(3).map((node) => listener(node)),
    });
    const result = prom(plan(profile));
    expect(result.targets.map((target) => target.node)).toEqual(nodeNames(3));
    expect(result.partial).toEqual([]);
    expect(result.uncoveredNodes).toEqual([]);
  });

  it('AC-11 an LB-fronted cluster with fewer targets than nodes is marked partial, with the nodes it misses', () => {
    const profile = profileOf({
      lb: true,
      nodes: nodeNames(3),
      endpoints: [listener('rabbit@n1')],
    });
    const result = prom(plan(profile));
    expect(result.targets).toHaveLength(1);
    expect(result.partial).toEqual(['load-balancer-fronted']);
    expect(result.uncoveredNodes).toEqual(['rabbit@n2', 'rabbit@n3']);
    // Not behind a balancer, still short of an endpoint: a different reason.
    const direct = prom(
      plan(
        profileOf({
          nodes: nodeNames(2),
          endpoints: [listener('rabbit@n1')],
        }),
      ),
    );
    expect(direct.partial).toEqual(['nodes-without-endpoint']);
    expect(direct.uncoveredNodes).toEqual(['rabbit@n2']);
  });
});

describe('planScrape: request shape and cadence', () => {
  const four = profileOf({ endpoints: [listener('rabbit@n1')] });

  it('AC-12 the aggregated page always, the detailed page only on demand, queue= only where allowed', () => {
    expect(prom(plan(four)).targets[0]?.steps).toEqual([
      { kind: 'aggregated', path: '/metrics' },
    ]);

    const demand: QueueDemand[] = [
      { vhost: '/', name: 'orders.v1' },
      { vhost: '/', name: 'a|b' },
      { vhost: 'shop', name: 'carts' },
      { vhost: '/', name: 'orders.v1' },
    ];
    const withFilter = prom(plan(four, { queues: demand }));
    expect(withFilter.targets[0]?.steps).toEqual([
      { kind: 'aggregated', path: '/metrics' },
      {
        kind: 'detailed',
        path: '/metrics/detailed',
        query: {
          family: ['queue_coarse_metrics', 'queue_consumer_count'],
          vhost: '/',
          queue: '^(?:a\\|b|orders\\.v1)$',
        },
      },
      {
        kind: 'detailed',
        path: '/metrics/detailed',
        query: {
          family: ['queue_coarse_metrics', 'queue_consumer_count'],
          vhost: 'shop',
          queue: '^(?:carts)$',
        },
      },
    ]);
    expect(withFilter.partial).toEqual([]);

    // Without the queue= capability: one read per vhost, no filter, and the note says so.
    const noFilter = prom(
      plan(
        profileOf({ endpoints: [listener('rabbit@n1')], queueFilter: false }),
        {
          queues: demand,
        },
      ),
    );
    const detailed = noFilter.targets[0]?.steps.filter(
      (s) => s.kind === 'detailed',
    );
    expect(detailed?.map((step) => step.query)).toEqual([
      { family: ['queue_coarse_metrics', 'queue_consumer_count'], vhost: '/' },
      {
        family: ['queue_coarse_metrics', 'queue_consumer_count'],
        vhost: 'shop',
      },
    ]);
    expect(noFilter.notes).toContain('unfiltered-detailed');
  });

  it('AC-12 queue= is chunked at 2,000 characters and at most 8 requests', () => {
    const result = prom(
      plan(four, {
        queues: queues(150, '/', 'queue.name.long.'),
        limits: { ...DEFAULT_METRICS_LIMITS, maxPinnedQueues: 200 },
      }),
    );
    const steps = result.targets[0]?.steps ?? [];
    const detailed = steps.filter((step) => step.kind === 'detailed');
    expect(detailed.length).toBeGreaterThan(1);
    for (const step of detailed) {
      const regex = (step.query as { queue: string }).queue;
      expect(regex.length).toBeLessThanOrEqual(2_000);
      expect(regex.startsWith('^(?:')).toBe(true);
    }
    // 150 names of 20 characters fit in a few chunks, none lost: every name is in exactly one regex.
    const all = detailed
      .map((s) => (s.query as { queue: string }).queue)
      .join('|');
    for (const q of queues(150, '/', 'queue.name.long.')) {
      expect(all.split(q.name.replace(/\./g, '\\.')).length - 1).toBe(1);
    }

    // More than fits in eight requests: the rest is dropped, said so, and the plan is partial.
    const many = prom(
      plan(four, { queues: queues(1_000, '/', 'a'.repeat(40)) }),
    );
    // Demand itself is capped at 50 queues first.
    expect(many.notes).toContain('queue-demand-truncated');
    expect(many.partial).toContain('queue-demand-truncated');
    const limited = prom(
      plan(four, {
        queues: queues(50, '/', 'a'.repeat(100)),
        limits: {
          ...DEFAULT_METRICS_LIMITS,
          maxQueryRegexChars: 300,
          maxDetailedRequests: 3,
        },
      }),
    );
    expect(
      limited.targets[0]?.steps.filter((step) => step.kind === 'detailed'),
    ).toHaveLength(3);
    expect(limited.notes).toContain('queue-demand-truncated');
  });

  it('AC-12 the interval is the largest of the base, the provider minimum and ten scrape durations, clamped', () => {
    const id = targetId('rabbit@n1', 'http://broker.example:15692/metrics');
    const at = (
      lastDurationMs: number | undefined,
      minIntervalSec = 15,
    ): number =>
      prom(
        plan(
          profileOf({ endpoints: [listener('rabbit@n1')], minIntervalSec }),
          {
            history:
              lastDurationMs === undefined
                ? new Map()
                : new Map([[id, { lastDurationMs }]]),
          },
        ),
      ).intervalMs;
    expect(at(undefined)).toBe(15_000);
    expect(at(200)).toBe(15_000);
    expect(at(4_000)).toBe(40_000);
    expect(at(100_000)).toBe(300_000);
    expect(at(200, 60)).toBe(60_000);
    // A provider that documents more than the clamp is obeyed.
    expect(at(200, 600)).toBe(600_000);
  });
});

describe('planScrape: fallback', () => {
  it('AC-13 no endpoint reads the management API, aggregate reads only where objects are off limits', () => {
    const result = plan(profileOf({ perObject: false }), {
      queues: queues(5),
    });
    expect(result).toMatchObject({
      source: 'management',
      reason: 'no-endpoint',
      reads: ['overview', 'nodes'],
      queues: [],
      intervalMs: 30_000,
    });
    expect(result.partial).toEqual(['fallback', 'per-object-unavailable']);
    expect(result.notes).toContain('per-object-not-allowed');
  });

  it('AC-13 where per-object reads are allowed, demanded queues are read one by one, capped', () => {
    const result = plan(profileOf({ perObject: true }), { queues: queues(40) });
    expect(result.source).toBe('management');
    if (result.source !== 'management') return;
    expect(result.queues).toHaveLength(20);
    expect(result.partial).toEqual(['fallback']);
  });

  it('AC-13 a failing Prometheus plan falls back, and the management interval obeys the provider and the cost', () => {
    const profile = profileOf({
      endpoints: [listener('rabbit@n1')],
      minIntervalSec: 60,
    });
    const result = plan(profile, {
      fallback: true,
      history: new Map([['management', { lastDurationMs: 9_000 }]]),
    });
    expect(result).toMatchObject({
      source: 'management',
      reason: 'failing',
      intervalMs: 90_000,
    });
    expect(plan(profile, { fallback: false }).source).toBe('prometheus');
  });
});
