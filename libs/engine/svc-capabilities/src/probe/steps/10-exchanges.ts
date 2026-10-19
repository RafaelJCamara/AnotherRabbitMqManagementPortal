// Step 10, exchanges: whether `amq.rabbitmq.event` and `amq.rabbitmq.trace` exist in the default
// vhost. The event exchange is there when its plugin is on; the trace exchange is there while
// tracing is on. A single GET each: 404 is "absent", any other failure leaves the fact unknown.
import { failureReason, type ProbeStep } from '../types';
import { read } from '../read';
import { ExchangeSchema } from '../schemas';

const DEFAULT_VHOST = encodeURIComponent('/');

export const exchangesStep: ProbeStep = {
  id: 'exchanges',
  async run(env, facts) {
    const exists = async (name: string): Promise<boolean | undefined> => {
      try {
        await read(
          env,
          `/api/exchanges/${DEFAULT_VHOST}/${name}`,
          ExchangeSchema,
        );
        return true;
      } catch (error) {
        env.signal.throwIfAborted();
        const { reason } = failureReason(error);
        return reason.includes('404') ? false : undefined;
      }
    };
    env.signal.throwIfAborted();
    const event = await exists('amq.rabbitmq.event');
    const trace = await exists('amq.rabbitmq.trace');
    facts.exchanges = { event, trace };
    if (event === undefined && trace === undefined) {
      return {
        status: 'unavailable',
        detail: 'neither exchange could be looked up',
      };
    }
    return {
      status: 'ok',
      detail: `event exchange ${label(event)}, trace exchange ${label(trace)}`,
    };
  },
};

const label = (found: boolean | undefined): string =>
  found === undefined ? 'unknown' : found ? 'present' : 'absent';
