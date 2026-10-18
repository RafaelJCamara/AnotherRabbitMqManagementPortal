// Role `control`: metadata over AMQP 0-9-1 (passive declares), on a connection that never holds a
// message. Every call runs on its own throwaway channel: a passive declare of a missing queue is a
// 404 that closes its channel (403 and 405 do the same), and that must not take anything else
// with it. The lease has no `get`, `consume`, `publish` or settle method at all.
//
// The HTTP half of the control role (the management client) is `adapter-mgmt-http`; this is the
// part that needs the protocol (OQ-214).
import type { QueueCounts } from '@app/ports';

import type { Amqp091Connection } from '../connect.ts';
import { withTimeout } from '../channel.ts';
import { Amqp091Error } from '../errors.ts';
import { badReleaseState, MAX_THROWAWAY, requireName } from './shared.ts';

export interface ControlLease {
  checkQueue(name: string): Promise<QueueCounts>;
  checkExchange(name: string): Promise<void>;
  release(state?: 'healthy' | 'poisoned'): Promise<void>;
}

export function createControlLease(
  connection: Amqp091Connection,
): ControlLease {
  let released: Promise<void> | undefined;
  let inFlight = 0;

  function live(): void {
    if (released !== undefined) {
      throw new Amqp091Error('released', 'the lease was released');
    }
    connection.assertOpen();
  }

  async function onThrowaway<T>(
    what: string,
    run: (
      channel: Awaited<ReturnType<Amqp091Connection['openChannel']>>,
    ) => Promise<T>,
  ): Promise<T> {
    live();
    if (inFlight >= MAX_THROWAWAY) {
      throw new Amqp091Error(
        'busy',
        `at most ${String(MAX_THROWAWAY)} passive declares at once`,
      );
    }
    inFlight += 1;
    try {
      const channel = await connection.openChannel();
      try {
        return await withTimeout(
          run(channel),
          connection.operationTimeoutMs,
          what,
        );
      } catch (error) {
        throw channel.explain(error, what);
      } finally {
        await channel.close(connection.operationTimeoutMs);
      }
    } finally {
      inFlight -= 1;
    }
  }

  const lease: ControlLease = {
    async checkQueue(name) {
      const queue = requireName(name, 'the queue name');
      return onThrowaway('a passive queue declare', async (channel) => {
        const ok = await channel.raw.checkQueue(queue);
        return {
          messageCount: ok.messageCount,
          consumerCount: ok.consumerCount,
        };
      });
    },

    async checkExchange(name) {
      const exchange = requireName(name, 'the exchange name');
      await onThrowaway('a passive exchange declare', async (channel) => {
        await channel.raw.checkExchange(exchange);
      });
    },

    release(state = 'healthy'): Promise<void> {
      const refusal = badReleaseState(state);
      if (refusal !== undefined) return Promise.reject(refusal);
      released ??= connection.close(state === 'healthy' ? 'graceful' : 'abort');
      return released;
    },
  };
  return Object.freeze(lease);
}
