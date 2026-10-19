// What the client does to a request before it is sent (DC-32/48, I-7): it checks the path, pages
// every list, clamps `page_size`, asks only for the columns the engine reads, and drops the
// statistics flags the broker would answer 400 to. The caller's query is never trusted to be safe
// for the broker in front of it, and no version is compared here: the registry's capability
// predicates (`channelsAcceptDisableStats`, ...) decide (I-3).
import type { MgmtQuery } from '@app/ports';
import type { BrokerProfile } from '@app/domain-model';

import { matchEndpoint, type EndpointSpec } from './endpoints/index.ts';
import { MgmtHttpError } from './errors.ts';
import { clampPageSize } from './paging.ts';
import { isRabbitMqFamily } from './product.ts';

/** What the rules need to know about the broker; the registry's `capability` takes the same. */
export type QueryProfile = Pick<
  BrokerProfile,
  'versions' | 'stats' | 'product'
>;
export type CapabilityCheck = (id: string, profile: QueryProfile) => boolean;

const SAFE_PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;
const KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const COLUMNS = /^[A-Za-z0-9_.,-]{1,2000}$/;
const MAX_VALUE_LENGTH = 2048;
const CHANNELS_PATH = /^\/api\/(?:channels(?:\/|$)|vhosts\/[^/]+\/channels$)/;

/** The channel endpoints, the ones the stats-off hazard is about (DC-32). */
export function isChannelsPath(path: string): boolean {
  return CHANNELS_PATH.test(path);
}
const QUEUE_LISTS: ReadonlySet<string> = new Set([
  'queues.list',
  'queues.inVhost',
]);

/**
 * A path is `/` and unreserved or percent-encoded characters: no query, no fragment, no `..`
 * segment and no `//` start (which a URL parser would read as another host).
 */
export function assertSafePath(path: string): void {
  if (
    !SAFE_PATH.test(path) ||
    path.startsWith('//') ||
    path.split('/').some(isDotSegment)
  ) {
    throw new MgmtHttpError('invalid-request', 'the request path is not valid');
  }
}

/** `.` and `..`, also when percent-encoded; an invalid escape counts as one. */
function isDotSegment(segment: string): boolean {
  try {
    const decoded = decodeURIComponent(segment);
    return decoded === '.' || decoded === '..';
  } catch {
    return true;
  }
}

function assertSafeValue(key: string, value: string | number | boolean): void {
  if (!KEY.test(key)) {
    throw new MgmtHttpError('invalid-request', 'a query key is not valid');
  }
  if (
    typeof value === 'string' &&
    (value.length > MAX_VALUE_LENGTH || /[\u0000-\u001f\u007f]/.test(value))
  ) {
    throw new MgmtHttpError(
      'invalid-request',
      `the query value of ${key} is not valid`,
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new MgmtHttpError(
      'invalid-request',
      `the query value of ${key} is not a number`,
    );
  }
}

export interface ShapedRequest {
  /** Path and encoded query, ready to send after the target's path prefix. */
  readonly target: string;
  readonly endpoint: EndpointSpec | undefined;
  /** The query as it will be sent (for tests and for the scheduler's cache key). */
  readonly query: Readonly<Record<string, string | number | boolean>>;
}

export function shapeRequest(
  path: string,
  query: MgmtQuery | undefined,
  profile: QueryProfile,
  capability: CapabilityCheck,
): ShapedRequest {
  assertSafePath(path);
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(query ?? {})) {
    assertSafeValue(key, value);
    out[key] = value;
  }
  const endpoint = matchEndpoint(path);

  // I-7: a list is always paged, and never more than the broker's own ceiling per page.
  if (endpoint?.paged === true || 'page_size' in out || 'page' in out) {
    out.page_size = clampPageSize(out.page_size);
    const page = Math.floor(Number(out.page ?? 1));
    out.page = Number.isFinite(page) && page >= 1 ? page : 1;
  }

  // The broker computes only what the engine reads.
  const columns = out.columns;
  if (columns === undefined) {
    if (endpoint?.columns !== undefined) {
      out.columns = endpoint.columns.join(',');
    }
  } else if (typeof columns !== 'string' || !COLUMNS.test(columns)) {
    throw new MgmtHttpError('invalid-request', 'the columns are not valid');
  }

  // Statistics flags are RabbitMQ's. The channel list answers 400 to `disable_stats` below the
  // release that fixed it, so the flag is never sent unless the registry says it is accepted.
  if (!isRabbitMqFamily(profile.product)) {
    delete out.disable_stats;
    delete out.enable_queue_totals;
  } else {
    if (
      isChannelsPath(path) &&
      !capability('channelsAcceptDisableStats', profile)
    ) {
      delete out.disable_stats;
    }
    if ('enable_queue_totals' in out) {
      const id =
        endpoint !== undefined && QUEUE_LISTS.has(endpoint.id)
          ? 'enableQueueTotalsOnQueueLists'
          : endpoint?.id === 'queues.one'
            ? 'enableQueueTotalsOnSingleQueue'
            : undefined;
      if (id === undefined || !capability(id, profile)) {
        delete out.enable_queue_totals;
      }
    }
  }

  const pairs = Object.keys(out)
    .sort()
    .map(
      (key) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(String(out[key]))}`,
    );
  return {
    target: pairs.length === 0 ? path : `${path}?${pairs.join('&')}`,
    endpoint,
    query: out,
  };
}
