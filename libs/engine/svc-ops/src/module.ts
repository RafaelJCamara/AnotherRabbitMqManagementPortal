// The composition root calls createOpsModule with the ports this service needs and
// registers what the module returns. A service never imports another service or an adapter:
// cross-service needs are ports wired in the composition root.
import type { ActionImpl } from '@app/kernel';

import { createActions } from './actions';
import type { OpsModuleDeps } from './deps';
import { jobs } from './jobs';
import { topics } from './topics';

/**
 * What the composition root registers. This is a local stand-in: replace it with the type
 * exported by the kernel once libs/engine/kernel provides EngineModule.
 */
export interface EngineModule {
  readonly id: string;
  readonly actions: readonly ActionImpl[];
  readonly topics: readonly unknown[];
  readonly jobs: readonly unknown[];
}

export function createOpsModule(deps: OpsModuleDeps): EngineModule {
  return { id: 'svc-ops', actions: createActions(deps), topics, jobs };
}
