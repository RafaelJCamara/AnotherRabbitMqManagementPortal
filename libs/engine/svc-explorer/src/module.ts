// The composition root calls createExplorerModule with the ports this service needs and
// registers what the module returns. A service never imports another service or an adapter:
// cross-service needs are ports wired in the composition root.
import { createActions } from './actions';
import type { ExplorerModuleDeps } from './deps';
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

export function createExplorerModule(deps: ExplorerModuleDeps): EngineModule {
  return { id: 'svc-explorer', actions: createActions(deps), topics, jobs };
}
