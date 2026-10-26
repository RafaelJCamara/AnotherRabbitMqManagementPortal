// Fakes for the peek preflight and the rescue preflight (M1-13). Slice A holds what the quarantine
// spec needs: a recording `send`, a `send` that fails the run when touched, and a found queue built
// from a spec. The scripted management API and the fake `PeekEvidencePort` arrive with the preflight
// that reads them (slice B), so no fake exists here that no test uses.
import type { MgmtSendRequest } from '@app/ports';

import type {
  FoundQueue,
  QuarantineQueueSpec,
  QuarantineSend,
} from './quarantine.ts';

export interface RecordedSend {
  readonly method: MgmtSendRequest<unknown>['method'];
  readonly path: string;
  readonly body: unknown;
}

/** A `send` that records what it was given and answers like a broker that accepts the request. */
export function createRecordingSend(
  behaviour: (call: RecordedSend) => Promise<unknown> = () =>
    Promise.resolve(undefined),
): { readonly send: QuarantineSend; readonly calls: readonly RecordedSend[] } {
  const calls: RecordedSend[] = [];
  const send: QuarantineSend = (request) => {
    const call = {
      method: request.method,
      path: request.path,
      body: request.body,
    };
    calls.push(call);
    return behaviour(call);
  };
  return { send, calls };
}

/** A `send` that fails the test run when anything reaches it. */
export const throwingSend: QuarantineSend = () => {
  throw new Error('a write was attempted where none is allowed');
};

/** What a queue found on the broker looks like when it is the spec; `overrides` make it differ. */
export function foundFromSpec(
  spec: QuarantineQueueSpec,
  overrides: Partial<FoundQueue> = {},
): FoundQueue {
  return {
    name: spec.name,
    vhost: spec.vhost,
    type: spec.arguments['x-queue-type'],
    durable: spec.durable,
    autoDelete: spec.autoDelete,
    arguments: { ...spec.arguments },
    ...overrides,
  };
}
