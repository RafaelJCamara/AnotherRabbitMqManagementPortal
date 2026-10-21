// Seeds many queues into a lab broker, for the explorer's scale runs (M0-48 slice F, S-13).
//
// This is test tooling for a throwaway lab broker, not engine code: the engine never writes to a
// broker through it (I-2). It imports definitions (`POST /api/definitions`) in batches instead of
// declaring queues one by one: the lab broker runs the whole import server-side, so 20,000 queues
// are a handful of requests and not 20,000 round trips. Queues are durable classic queues spread
// evenly across `vhosts` vhosts, named so that the order is the same on every run.
import { call, type Login } from '../golden/http.ts';

export interface SeedQueuesOptions {
  /** `http://127.0.0.1:<port>`: the broker's management origin. */
  readonly origin: string;
  readonly login: Login;
  /** How many queues to create in all. */
  readonly count: number;
  /** How many vhosts to spread them across (default 4). */
  readonly vhosts?: number;
  /** Queues per import request (default 2,500). */
  readonly batch?: number;
}

export interface SeededQueues {
  readonly count: number;
  readonly vhosts: readonly string[];
  /** Import requests made. */
  readonly batches: number;
  /** Wall-clock time of the imports in milliseconds (the broker may still be starting queue processes). */
  readonly ms: number;
}

const DEFAULT_VHOSTS = 4;
const DEFAULT_BATCH = 2_500;

export const vhostName = (index: number): string =>
  `explorer-${String(index).padStart(2, '0')}`;
export const queueName = (index: number): string =>
  `queue-${String(index).padStart(6, '0')}`;

/** Imports `count` queues across `vhosts` vhosts; throws with the broker's status on a refusal. */
export async function seedQueues(
  options: SeedQueuesOptions,
): Promise<SeededQueues> {
  const vhostCount = options.vhosts ?? DEFAULT_VHOSTS;
  const batch = options.batch ?? DEFAULT_BATCH;
  if (
    !Number.isInteger(options.count) ||
    options.count < 1 ||
    !Number.isInteger(vhostCount) ||
    vhostCount < 1 ||
    !Number.isInteger(batch) ||
    batch < 1
  ) {
    throw new Error(
      'seedQueues: count, vhosts and batch are positive integers',
    );
  }
  const vhosts = Array.from({ length: vhostCount }, (_, i) => vhostName(i));
  const began = Date.now();
  let batches = 0;
  for (let from = 0; from < options.count; from += batch) {
    const queues = [];
    for (let i = from; i < Math.min(from + batch, options.count); i++) {
      queues.push({
        name: queueName(i),
        vhost: vhosts[i % vhostCount],
        durable: true,
        auto_delete: false,
        arguments: { 'x-queue-type': 'classic' },
      });
    }
    // The first request also declares the vhosts and lets the login use them: a user sees the
    // queues of a vhost only with a permission on it.
    const body =
      from === 0
        ? {
            vhosts: vhosts.map((name) => ({ name })),
            permissions: vhosts.map((vhost) => ({
              user: options.login.username,
              vhost,
              configure: '.*',
              write: '.*',
              read: '.*',
            })),
            queues,
          }
        : { queues };
    const reply = await call(options.origin, 'POST', '/api/definitions', {
      login: options.login,
      body,
    });
    batches++;
    if (reply.status !== 204) {
      throw new Error(
        `seedQueues: the definitions import answered ${String(reply.status)} at queue ${String(from)}`,
      );
    }
  }
  return {
    count: options.count,
    vhosts,
    batches,
    ms: Date.now() - began,
  };
}

/**
 * Waits until the broker's own count (`object_totals.queues` of `/api/overview`) reaches `expected`.
 * The count comes from the metrics collector, so it can trail the import by a few seconds. Returns
 * the milliseconds waited.
 */
export async function waitForQueueTotal(
  options: Pick<SeedQueuesOptions, 'origin' | 'login'> & {
    readonly expected: number;
    readonly timeoutMs?: number;
  },
): Promise<number> {
  const began = Date.now();
  const deadline = began + (options.timeoutMs ?? 300_000);
  let last = 'no answer yet';
  while (Date.now() < deadline) {
    const reply = await call(options.origin, 'GET', '/api/overview', {
      login: options.login,
    }).catch(() => undefined);
    if (reply?.status === 200) {
      const total = (
        JSON.parse(reply.text) as { object_totals?: { queues?: number } }
      ).object_totals?.queues;
      if (total === options.expected) return Date.now() - began;
      last = `object_totals.queues is ${String(total)}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `the broker did not report ${String(options.expected)} queues in time (${last})`,
  );
}
