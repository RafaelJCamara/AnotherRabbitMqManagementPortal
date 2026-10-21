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
  /** The queue names the broker holds, per vhost, in the order it pages them. */
  readonly vhosts: readonly string[];
  readonly queueCount: number;
}

/** The broker's own page ceiling. */
const BROKER_MAX_PAGE_SIZE = 500;

/**
 * A management API with `queueCount` queues spread evenly across `vhostCount` vhosts. `/api/queues`
 * answers the paged envelope (`page`, `page_size`, ceiling 500); every other path answers 404, like a
 * broker without the endpoint. Every request is recorded.
 */
export function createScriptedBroker(
  options: { queueCount?: number; vhostCount?: number } = {},
): ScriptedBroker {
  const queueCount = options.queueCount ?? 0;
  const vhostCount = Math.max(1, options.vhostCount ?? 1);
  const vhosts = Array.from({ length: vhostCount }, (_, i) =>
    i === 0 ? '/' : `vhost-${String(i)}`,
  );
  const queue = (i: number) => ({
    name: `queue-${String(i).padStart(6, '0')}`,
    vhost: vhosts[i % vhostCount],
    durable: true,
    messages: i % 100,
  });
  const requests: RecordedRequest[] = [];

  const read: MgmtReadPort = {
    get<T>(request: MgmtGetRequest<T>): Promise<T> {
      const query = request.query ?? {};
      requests.push({ path: request.path, query, lane: request.lane });
      if (request.path !== '/api/queues') {
        return Promise.reject(
          Object.assign(new Error('NOT_FOUND: HTTP 404'), {
            code: 'NOT_FOUND',
            broker: { protocol: 'http', code: 404 },
          }),
        );
      }
      const pageSize = Math.min(
        Number(query.page_size ?? BROKER_MAX_PAGE_SIZE),
        BROKER_MAX_PAGE_SIZE,
      );
      const page = Number(query.page ?? 1);
      const from = (page - 1) * pageSize;
      const items = Array.from(
        { length: Math.max(0, Math.min(pageSize, queueCount - from)) },
        (_, i) => queue(from + i),
      );
      return Promise.resolve(
        request.schema.parse({
          items,
          page,
          page_size: pageSize,
          page_count: Math.ceil(queueCount / pageSize),
          total_count: queueCount,
          filtered_count: queueCount,
          item_count: items.length,
        }),
      );
    },
    stream: () => Promise.reject(new Error('the explorer never streams')),
  };
  return { read, requests, vhosts, queueCount };
}

export interface ExplorerFakeDeps extends ExplorerModuleDeps {
  readonly broker: ScriptedBroker;
}

export function createExplorerFakeDeps(
  options: {
    ownerId?: string;
    queueCount?: number;
    vhostCount?: number;
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
