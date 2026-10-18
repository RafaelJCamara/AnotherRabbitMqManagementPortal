// The Mgmt and Prometheus ports behind the BrokerScheduler (I-8). The composition root wraps each
// adapter with one of these and hands only the wrapper to services; the raw adapter is never
// injected anywhere else.
import type {
  Lane,
  MgmtGetRequest,
  MgmtQuery,
  MgmtReadPort,
  MgmtSendRequest,
  MgmtStreamRequest,
  MgmtWritePort,
  PromScrapePort,
  PromScrapeRequest,
} from '@app/ports';

import type { BrokerScheduler } from './broker-scheduler.ts';

// A schema is part of what a GET returns (it parses the body), so two requests are "identical"
// only when they share the schema object too. Ids are handed out per schema object.
const schemaIds = new WeakMap<object, number>();
let nextSchemaId = 0;

function schemaId(schema: object): number {
  let id = schemaIds.get(schema);
  if (id === undefined) {
    id = nextSchemaId++;
    schemaIds.set(schema, id);
  }
  return id;
}

function queryKey(query: MgmtQuery | undefined): string {
  if (query === undefined) return '';
  return Object.keys(query)
    .sort()
    .map(
      (name) =>
        `${encodeURIComponent(name)}=${encodeURIComponent(String(query[name]))}`,
    )
    .join('&');
}

/**
 * Reads through the scheduler. A `get` is single-flighted and reused for the scheduler's
 * `detailCacheMs`, so callers must treat the result as immutable. A `stream` is never cached and
 * holds its slot until the body has been read, abandoned or the hold times out.
 */
export function scheduleMgmtRead(
  inner: MgmtReadPort,
  scheduler: BrokerScheduler,
): MgmtReadPort {
  return {
    get<T>(request: MgmtGetRequest<T>, signal: AbortSignal): Promise<T> {
      return scheduler.run(
        {
          connectionId: request.connectionId,
          lane: request.lane,
          signal,
          dedupeKey: `GET ${request.path}?${queryKey(request.query)}#${String(schemaId(request.schema))}`,
        },
        (taskSignal) => inner.get(request, taskSignal),
      );
    },
    async stream(request: MgmtStreamRequest, signal: AbortSignal) {
      const held = await scheduler.holdSlot(
        { connectionId: request.connectionId, lane: request.lane, signal },
        (taskSignal) => inner.stream(request, taskSignal),
      );
      return releasingIterable(held.value, held.release);
    },
  };
}

export interface ScheduledWriteOptions {
  /** The lane of writes. Defaults to `interactive`: a write is a person's or a job's decision, not a sweep. */
  lane?: Lane;
}

/** Writes through the scheduler: queued by lane, never cached, never merged, never retried. */
export function scheduleMgmtWrite(
  inner: MgmtWritePort,
  scheduler: BrokerScheduler,
  options: ScheduledWriteOptions = {},
): MgmtWritePort {
  const lane = options.lane ?? 'interactive';
  return {
    send<T>(request: MgmtSendRequest<T>, signal: AbortSignal): Promise<T> {
      return scheduler.run(
        { connectionId: request.connectionId, lane, signal },
        (taskSignal) => inner.send(request, taskSignal),
      );
    },
  };
}

/** Prometheus scrapes through the scheduler. Not cached; the body holds the slot until read. */
export function schedulePromScrape(
  inner: PromScrapePort,
  scheduler: BrokerScheduler,
): PromScrapePort {
  return {
    async scrape(request: PromScrapeRequest, signal: AbortSignal) {
      const held = await scheduler.holdSlot(
        { connectionId: request.connectionId, lane: request.lane, signal },
        (taskSignal) => inner.scrape(request, taskSignal),
      );
      return releasingIterable(held.value, held.release);
    },
  };
}

/** The same chunks, calling `release` when the consumer finishes, fails or stops early. */
function releasingIterable(
  source: AsyncIterable<Uint8Array>,
  release: () => void,
): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      const iterator = source[Symbol.asyncIterator]();
      return {
        async next() {
          try {
            const result = await iterator.next();
            if (result.done === true) release();
            return result;
          } catch (error) {
            release();
            throw error;
          }
        },
        async return(value?: unknown) {
          release();
          return iterator.return
            ? await iterator.return(value)
            : { done: true as const, value: undefined };
        },
        async throw(error?: unknown) {
          release();
          if (iterator.throw) return await iterator.throw(error);
          throw error instanceof Error ? error : new Error('Iteration failed.');
        },
      };
    },
  };
}
