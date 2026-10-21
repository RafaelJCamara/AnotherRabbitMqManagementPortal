// Fakes for the ports of this module, shared by its specs, by the architecture manifest
// (tools/arch-tests) and by the HTTP specs (libs/testkit).
import type { Lane, MgmtGetRequest, MgmtReadPort } from '@app/ports';

import type { ExplorerModuleDeps } from './deps';

/** The connection every fake starts with: owned by the test principal (`user-1`). */
export const FAKE_CONNECTION_ID = 'c1';

/** One management request, as the scripted broker saw it. */
export interface RecordedRequest {
  readonly path: string;
  readonly query: Readonly<Record<string, string | number | boolean>>;
  readonly lane: Lane;
}

export interface ScriptedBroker {
  /** The read port a module is given. */
  readonly read: MgmtReadPort;
  /** Every request, in order. */
  readonly requests: RecordedRequest[];
  /** The vhosts the broker holds, in the order `/api/vhosts` lists them. */
  readonly vhosts: readonly string[];
  readonly queueCount: number;
  /**
   * Called with every request and its 1-based ordinal before it is answered: return an error to
   * fail it (its text is broker text, which no output may carry). Settable by a spec.
   */
  intercept?:
    | ((request: RecordedRequest, ordinal: number) => Error | undefined)
    | undefined;
}

/** The broker's own page ceiling. */
const BROKER_MAX_PAGE_SIZE = 500;

/** A management failure as the scheduled port throws it. */
export function brokerFailure(status = 503): Error {
  return Object.assign(new Error(`HTTP ${String(status)} secret-broker-text`), {
    code: 'BROKER_UNREACHABLE',
    broker: { protocol: 'http', code: status },
  });
}

/**
 * A management API with `queueCount` queues spread evenly across `vhostCount` vhosts (and
 * `exchangesPerVhost` exchanges in each). `/api/queues` (all vhosts), `/api/queues/{vhost}` and
 * `/api/exchanges/{vhost}` answer the paged envelope (`page`, `page_size`, ceiling 500);
 * `/api/vhosts` answers a bare array; every other path answers 404, like a broker without the
 * endpoint. Every request is recorded.
 */
export function createScriptedBroker(
  options: {
    queueCount?: number;
    vhostCount?: number;
    exchangesPerVhost?: number;
  } = {},
): ScriptedBroker {
  const queueCount = options.queueCount ?? 0;
  const vhostCount = Math.max(1, options.vhostCount ?? 1);
  const exchangeCount = options.exchangesPerVhost ?? 0;
  const vhosts = Array.from({ length: vhostCount }, (_, i) =>
    i === 0 ? '/' : `vhost-${String(i)}`,
  );
  const queue = (i: number) => ({
    name: `queue-${String(i).padStart(6, '0')}`,
    vhost: vhosts[i % vhostCount],
    type: 'classic',
    durable: true,
    messages: i % 100,
  });
  const requests: RecordedRequest[] = [];

  const paged = <T>(
    request: MgmtGetRequest<T>,
    total: number,
    item: (i: number) => unknown,
  ): T => {
    const query = request.query ?? {};
    const pageSize = Math.min(
      Number(query.page_size ?? BROKER_MAX_PAGE_SIZE),
      BROKER_MAX_PAGE_SIZE,
    );
    const page = Number(query.page ?? 1);
    const from = (page - 1) * pageSize;
    const items = Array.from(
      { length: Math.max(0, Math.min(pageSize, total - from)) },
      (_, i) => item(from + i),
    );
    return request.schema.parse({
      items,
      page,
      page_size: pageSize,
      page_count: Math.max(1, Math.ceil(total / pageSize)),
      total_count: total,
      filtered_count: total,
      item_count: items.length,
    });
  };

  const broker: ScriptedBroker = {
    read: {
      get<T>(request: MgmtGetRequest<T>): Promise<T> {
        const recorded = {
          path: request.path,
          query: request.query ?? {},
          lane: request.lane,
        };
        requests.push(recorded);
        const failure = broker.intercept?.(recorded, requests.length);
        if (failure) return Promise.reject(failure);
        const [, , kind, rawVhost] = request.path.split('/');
        const vhost =
          rawVhost === undefined ? '' : decodeURIComponent(rawVhost);
        const at = vhosts.indexOf(vhost);
        if (request.path === '/api/vhosts') {
          return Promise.resolve(
            request.schema.parse(vhosts.map((name) => ({ name }))),
          );
        }
        if (request.path === '/api/queues') {
          return Promise.resolve(paged(request, queueCount, queue));
        }
        if (at >= 0 && kind === 'queues') {
          const own = Math.max(0, Math.ceil((queueCount - at) / vhostCount));
          return Promise.resolve(
            paged(request, own, (j) => queue(at + j * vhostCount)),
          );
        }
        if (at >= 0 && kind === 'exchanges') {
          return Promise.resolve(
            paged(request, exchangeCount, (j) => ({
              name: `exchange-${String(j)}`,
              vhost,
              type: 'direct',
              durable: true,
            })),
          );
        }
        return Promise.reject(
          Object.assign(new Error('NOT_FOUND: HTTP 404'), {
            code: 'NOT_FOUND',
            broker: { protocol: 'http', code: 404 },
          }),
        );
      },
      stream: () => Promise.reject(new Error('the explorer never streams')),
    },
    requests,
    vhosts,
    queueCount,
  };
  return broker;
}

export interface ExplorerFakeDeps extends ExplorerModuleDeps {
  readonly broker: ScriptedBroker;
}

export function createExplorerFakeDeps(
  options: {
    ownerId?: string;
    queueCount?: number;
    vhostCount?: number;
    exchangesPerVhost?: number;
  } = {},
): ExplorerFakeDeps {
  const broker = createScriptedBroker(options);
  const connection = {
    id: FAKE_CONNECTION_ID,
    name: 'Fake broker',
    envClass: 'dev',
    color: null,
    config: {},
    ownerId: options.ownerId ?? 'user-1',
    visibility: 'private' as const,
    createdAt: 1_000,
    updatedAt: 1_000,
  };
  return {
    broker,
    mgmt: broker.read,
    profiles: { get: () => Promise.resolve(undefined) },
    connections: {
      get: (id) =>
        Promise.resolve(id === FAKE_CONNECTION_ID ? connection : undefined),
    },
  };
}
