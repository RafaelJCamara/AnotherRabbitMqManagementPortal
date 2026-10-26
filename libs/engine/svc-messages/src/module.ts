// The composition root calls createMessagesModule with the ports this service needs and
// registers what the module returns. A service never imports another service or an adapter:
// cross-service needs are ports wired in the composition root.
import { createActions } from './actions';
import type { MessagesModuleDeps } from './deps';
import { createPublishHistory } from './internal/publish-history';
import { jobs } from './jobs';
import { topics } from './topics';

/**
 * What the composition root registers. This is a local stand-in: replace it with the type
 * exported by the kernel once libs/engine/kernel provides EngineModule.
 */
export interface EngineModule {
  readonly id: string;
  readonly actions: readonly unknown[];
  readonly topics: readonly unknown[];
  readonly jobs: readonly unknown[];
}

export function createMessagesModule(deps: MessagesModuleDeps): EngineModule {
  const store = createPublishHistory(deps);
  // Expired entries leave on every write and when the module starts (H5): there is no timer. A purge
  // that fails is retried by the next write; the engine does not wait for this one.
  void store.purge().catch(() => {
    deps.logger.warn(
      { event: 'messages.publish-history.purge-failed' },
      'expired publish history entries could not be purged',
    );
  });
  return {
    id: 'svc-messages',
    actions: createActions({ recorder: store, store, logger: deps.logger }),
    topics,
    jobs,
  };
}
