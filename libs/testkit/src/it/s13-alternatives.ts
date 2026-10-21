// The alternatives S-13 compares with the explorer's sweep (M0-48 slice F, OQ-662): what listing the
// queues of a lab broker costs the broker when it is done another way. Test tooling for a throwaway
// lab broker: plain GETs with the lab login, outside the engine and its Dialer, which is the point
// ("an unpaged request sent by the lab script outside the engine"; the engine itself can only send
// a paged list, DC-48). Nothing here is used by the engine.
import { call, type Login } from '../golden/http.ts';

/** The columns the management adapter asks for on a queue list (endpoints/queues.ts). */
const COLUMNS =
  'name,vhost,type,durable,auto_delete,exclusive,arguments,node,state,messages,messages_ready,messages_unacknowledged,consumers,policy,operator_policy,effective_policy_definition,delivery_limit';

export interface Variant {
  /** Short name used in the S-13 table. */
  readonly id: string;
  readonly description: string;
  /** Requests made to list every queue. */
  readonly requests: number;
  /** Wall-clock milliseconds for all of them, one after the other. */
  readonly totalMs: number;
  /** The slowest single request in milliseconds. */
  readonly maxRequestMs: number;
  /** Bytes of answers received. */
  readonly bytes: number;
  /** Queues received (a check that the variant listed everything). */
  readonly queues: number;
  /** Set when a request failed or timed out: the variant is then not comparable. */
  readonly failure?: string;
}

interface Listing {
  readonly path: string;
  readonly query: Readonly<Record<string, string | number | boolean>>;
}

const qs = (query: Listing['query']): string =>
  Object.entries(query)
    .map(
      ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
    )
    .join('&');

/** Reads one list to its end (or once, when the request carries no `page`). */
async function listAll(
  origin: string,
  login: Login,
  listing: Listing,
): Promise<Omit<Variant, 'id' | 'description'>> {
  let requests = 0;
  let totalMs = 0;
  let maxRequestMs = 0;
  let bytes = 0;
  let queues = 0;
  try {
    for (let page = 1; ; page++) {
      const paged = 'page' in listing.query;
      const query = paged ? { ...listing.query, page } : listing.query;
      const began = performance.now();
      const reply = await call(origin, 'GET', `${listing.path}?${qs(query)}`, {
        login,
      });
      const took = performance.now() - began;
      requests++;
      totalMs += took;
      maxRequestMs = Math.max(maxRequestMs, took);
      bytes += Buffer.byteLength(reply.text);
      if (reply.status !== 200) {
        return {
          requests,
          totalMs,
          maxRequestMs,
          bytes,
          queues,
          failure: `status ${String(reply.status)}`,
        };
      }
      const body = JSON.parse(reply.text) as
        | unknown[]
        | { items: unknown[]; page_count: number };
      if (Array.isArray(body)) {
        queues += body.length;
        break;
      }
      queues += body.items.length;
      if (page >= body.page_count || body.items.length === 0) break;
    }
  } catch (error) {
    return {
      requests,
      totalMs,
      maxRequestMs,
      bytes,
      queues,
      failure: error instanceof Error ? error.name : 'error',
    };
  }
  return { requests, totalMs, maxRequestMs, bytes, queues };
}

/**
 * Lists every queue of the broker in the ways S-13 compares: per vhost at three page sizes with the
 * statistics-off flags (the explorer's way), per vhost with statistics on, one global paged list,
 * and one unpaged global list.
 */
export async function measureAlternatives(
  origin: string,
  login: Login,
  options: { reverse?: boolean; only?: readonly string[] } = {},
): Promise<Variant[]> {
  const vhostNames = (
    JSON.parse((await call(origin, 'GET', '/api/vhosts', { login })).text) as {
      name: string;
    }[]
  ).map((vhost) => vhost.name);
  const flags = { disable_stats: true, enable_queue_totals: true } as const;

  const perVhost = async (
    id: string,
    description: string,
    query: Listing['query'],
  ): Promise<Variant> => {
    const parts = [];
    for (const vhost of vhostNames) {
      parts.push(
        await listAll(origin, login, {
          path: `/api/queues/${encodeURIComponent(vhost)}`,
          query,
        }),
      );
    }
    const failed = parts.find((p) => p.failure !== undefined)?.failure;
    return {
      id,
      description,
      requests: parts.reduce((s, p) => s + p.requests, 0),
      totalMs: parts.reduce((s, p) => s + p.totalMs, 0),
      maxRequestMs: Math.max(...parts.map((p) => p.maxRequestMs)),
      bytes: parts.reduce((s, p) => s + p.bytes, 0),
      queues: parts.reduce((s, p) => s + p.queues, 0),
      ...(failed === undefined ? {} : { failure: failed }),
    };
  };
  const global = async (
    id: string,
    description: string,
    query: Listing['query'],
  ): Promise<Variant> => ({
    id,
    description,
    ...(await listAll(origin, login, { path: '/api/queues', query })),
  });

  const runs: {
    id: string;
    run: () => Promise<Variant>;
  }[] = [
    {
      id: 'vhost-100',
      run: () =>
        perVhost('vhost-100', 'per vhost, page_size 100, stats off', {
          ...flags,
          columns: COLUMNS,
          page_size: 100,
          page: 1,
        }),
    },
    {
      id: 'vhost-200',
      run: () =>
        perVhost('vhost-200', 'per vhost, page_size 200, stats off', {
          ...flags,
          columns: COLUMNS,
          page_size: 200,
          page: 1,
        }),
    },
    {
      id: 'vhost-500',
      run: () =>
        perVhost(
          'vhost-500',
          'per vhost, page_size 500, stats off (the sweep)',
          { ...flags, columns: COLUMNS, page_size: 500, page: 1 },
        ),
    },
    {
      id: 'vhost-500-stats',
      run: () =>
        perVhost('vhost-500-stats', 'per vhost, page_size 500, statistics on', {
          columns: COLUMNS,
          page_size: 500,
          page: 1,
        }),
    },
    {
      id: 'global-500',
      run: () =>
        global('global-500', 'one global list, page_size 500, stats off', {
          ...flags,
          columns: COLUMNS,
          page_size: 500,
          page: 1,
        }),
    },
    {
      id: 'global-unpaged',
      run: () =>
        global('global-unpaged', 'one global list, no page, stats off', {
          ...flags,
          columns: COLUMNS,
        }),
    },
  ];
  // Reversing the order is how a second round tells the cost of a variant from the cost of
  // coming after the others (caches, JIT, the broker's own tables).
  const chosen = runs.filter(
    (entry) => options.only === undefined || options.only.includes(entry.id),
  );
  const results: Variant[] = [];
  for (const entry of options.reverse === true ? chosen.reverse() : chosen) {
    results.push(await entry.run());
  }
  return results;
}
