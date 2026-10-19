// What the recorder asks every broker (M0-25): one request for each endpoint of the adapter's
// catalogue, the same Prometheus pages, and a few error probes. The catalogue is the source, so an
// endpoint added to `@app/adapter-mgmt-http` has no fixture until it has a line here, and
// `plan.spec.ts` fails until it does.
import {
  ENDPOINTS,
  fillTemplate,
  type EndpointSpec,
  type QueryProfile,
} from '@app/adapter-mgmt-http';
import { parseSemVer } from '@app/domain-model';
import type { Product } from '@app/domain-model';

import type { ProbeAuth, QueryValue, StatsMode } from './types.ts';

export type Params = Readonly<Record<string, string>>;

/** A request of the plan before a broker answers it. */
export interface PlannedRequest {
  readonly id: string;
  readonly method: 'GET' | 'POST';
  /** Template filled with percent-encoded parameters. */
  readonly path: string;
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly body?: unknown;
}

/** Names a plan reads from the broker while it records (the first connection, the first channel). */
export interface Discovered {
  readonly connection?: string;
  readonly channel?: string;
}

const VHOST = 'golden';

/** The entry that reads `golden.classic` again right after the peek (`queues.get`). Not a catalogue endpoint. */
export const AFTER_GET = 'queues.afterGet';

/** Parameters of each endpoint that has placeholders; the value may need what was discovered. */
const PARAMS: Readonly<
  Record<
    string,
    (product: Product, found: Discovered) => Params | { skip: string }
  >
> = {
  'queues.inVhost': () => ({ vhost: VHOST }),
  'queues.one': (product) => ({
    vhost: VHOST,
    // A quorum queue with a delivery-limit policy is what the stats-off hazard hides; LavinMQ has
    // no quorum queues.
    name: product === 'lavinmq' ? 'golden.classic' : 'golden.quorum',
  }),
  'queues.get': () => ({ vhost: VHOST, name: 'golden.classic' }),
  'exchanges.inVhost': () => ({ vhost: VHOST }),
  'exchanges.one': () => ({ vhost: VHOST, name: 'golden.topic' }),
  'bindings.inVhost': () => ({ vhost: VHOST }),
  'bindings.fromExchange': () => ({ vhost: VHOST, name: 'golden.direct' }),
  'bindings.ofQueue': () => ({ vhost: VHOST, name: 'golden.classic' }),
  'vhosts.one': () => ({ vhost: VHOST }),
  'connections.inVhost': () => ({ vhost: VHOST }),
  'connections.one': (_product, found) =>
    found.connection === undefined
      ? { skip: 'the broker listed no connection to ask for' }
      : { name: found.connection },
  'channels.inVhost': () => ({ vhost: VHOST }),
  'channels.one': (_product, found) =>
    found.channel === undefined
      ? { skip: 'the broker listed no channel to ask for' }
      : { name: found.channel },
  'consumers.inVhost': () => ({ vhost: VHOST }),
  'policies.inVhost': () => ({ vhost: VHOST }),
  'policies.one': () => ({ vhost: VHOST, name: 'golden-ttl' }),
  'operatorPolicies.inVhost': () => ({ vhost: VHOST }),
  'operatorPolicies.one': () => ({ vhost: VHOST, name: 'golden-op' }),
  'users.one': () => ({ name: 'golden-monitor' }),
  'permissions.one': () => ({ vhost: VHOST, user: 'golden-monitor' }),
  'health.portListener': () => ({ port: '5672' }),
  'health.protocolListener': () => ({ protocol: 'amqp' }),
  'health.certificateExpiration': () => ({ within: '1', unit: 'years' }),
  'definitions.inVhost': () => ({ vhost: VHOST }),
};

const GET_BODY = {
  count: 2,
  ackmode: 'ack_requeue_true',
  encoding: 'auto',
  truncate: 50_000,
} as const;

/** Endpoints with no placeholder need no entry in `PARAMS`; every placeholder needs one. */
export function placeholdersOf(template: string): string[] {
  return [...template.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1] ?? '');
}

/**
 * The requests for one broker. With statistics off the lists carry the flags the engine sends
 * then (DC-32): `disable_stats` and `enable_queue_totals`; the client drops the ones the broker's
 * version does not accept.
 */
export function planRequests(
  product: Product,
  mode: StatsMode,
  found: Discovered,
  catalogue: readonly EndpointSpec[] = ENDPOINTS,
): { requests: PlannedRequest[]; skipped: { id: string; reason: string }[] } {
  const requests: PlannedRequest[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const spec of catalogue) {
    const resolve = PARAMS[spec.id];
    const needs = placeholdersOf(spec.template);
    if (needs.length > 0 && resolve === undefined) {
      throw new Error(
        `golden plan: ${spec.id} has placeholders (${needs.join(', ')}) and no parameters in plan.ts`,
      );
    }
    const params = resolve === undefined ? {} : resolve(product, found);
    if ('skip' in params) {
      skipped.push({ id: spec.id, reason: params.skip });
      continue;
    }
    const isGet = spec.id === 'queues.get';
    const query: Record<string, QueryValue> = {};
    if (mode === 'stats-off' && spec.stats) {
      query.disable_stats = true;
      query.enable_queue_totals = true;
    }
    requests.push({
      id: spec.id,
      method: isGet ? 'POST' : 'GET',
      path: fillTemplate(spec.template, params),
      ...(Object.keys(query).length > 0 ? { query } : {}),
      ...(isGet ? { body: GET_BODY } : {}),
    });
    if (isGet) {
      // What the peek left behind: the same queue read again after the statistics tick, so the
      // fixtures show whether `ack_requeue_true` (with `requeue: true` on LavinMQ) kept the messages.
      requests.push({
        id: AFTER_GET,
        method: 'GET',
        path: fillTemplate('/api/queues/{vhost}/{name}', {
          vhost: VHOST,
          name: 'golden.classic',
        }),
      });
    }
  }
  return { requests, skipped };
}

export interface ErrorProbe {
  readonly id: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly auth: ProbeAuth;
}

/**
 * Requests that fail on purpose: what a broker answers to a bad login, a missing tag, a missing
 * object, and (`error.vhosts-paged`) to the `page` parameter on the one list that does not take it.
 */
export const ERROR_PROBES: readonly ErrorProbe[] = [
  {
    id: 'error.vhosts-paged',
    path: '/api/vhosts',
    query: { page: 1, page_size: 100 },
    auth: 'guest',
  },
  { id: 'error.wrong-password', path: '/api/overview', auth: 'wrong-password' },
  { id: 'error.unknown-user', path: '/api/overview', auth: 'unknown-user' },
  {
    id: 'error.no-management-tag',
    path: '/api/overview',
    auth: 'no-management-tag',
  },
  {
    id: 'error.queue-not-found',
    path: '/api/queues/golden/golden.missing',
    auth: 'guest',
  },
];

export interface PrometheusProbe {
  readonly id: string;
  readonly path: string;
}

/** The pages the Prometheus adapter (M1) will read. `family` repeats, so it is part of the path. */
export const PROMETHEUS_PROBES: readonly PrometheusProbe[] = [
  { id: 'prometheus.metrics', path: '/metrics' },
  {
    id: 'prometheus.detailed-queues',
    path: '/metrics/detailed?family=queue_coarse_metrics&family=queue_consumer_count',
  },
];

/** The slice of a BrokerProfile the client's request rules read; the same as the adapter specs use. */
export function goldenProfile(
  product: Product,
  version: string,
  statsOff: boolean,
): QueryProfile {
  const parsed = parseSemVer(version);
  if (parsed === null) throw new Error(`golden: "${version}" is not a version`);
  return {
    product,
    stats: { disabled: statsOff, queueTotals: true },
    versions: {
      min: parsed,
      perNode: { 'rabbit@n0': parsed },
      mixed: false,
      build: 'oss',
    },
  };
}
