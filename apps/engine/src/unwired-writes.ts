// The write ports of this build. The management and AMQP adapters (M0-37 onwards) have not landed,
// so there is nothing real to hand an action: every write port refuses, with a stable code, and the
// executor still audits the attempt. This is the place to swap in the adapters when they exist; it
// must never become a place where a write silently succeeds.
import { AppError, type ExecutorWrite } from '@app/kernel';

const unwired = (what: string): AppError =>
  new AppError('CAPABILITY_MISSING', {
    detail: `${what} is not available in this build: no broker adapter is wired.`,
  });

export function createUnwiredWrites(): ExecutorWrite {
  return {
    mgmt: { send: () => Promise.reject(unwired('Broker management writes')) },
    connections: {
      peek: () => Promise.reject(unwired('A peek connection')),
      source: () => Promise.reject(unwired('A source connection')),
      publish: () => Promise.reject(unwired('A publish connection')),
      observe: () => Promise.reject(unwired('An observe connection')),
      budget: () => [],
      // Nothing is open and nothing may be: the cap is zero.
      usage: () => ({ inUse: 0, max: 0, queued: 0, brokerMax: null }),
    },
  };
}
