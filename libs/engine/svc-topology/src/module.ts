// The composition root calls createTopologyModule with the ports this service needs and
// registers what the module returns. A service never imports another service or an adapter:
// cross-service needs are ports wired in the composition root.
import type { ActionImpl } from '@app/kernel';

import { createActions } from './actions';
import type { TopologyModuleDeps } from './deps';
import { createSnapshotReader } from './internal/snapshot';

/** What the composition root registers: reads only, so no jobs, no topics and no write port. */
export interface EngineModule {
  readonly id: 'svc-topology';
  readonly actions: readonly ActionImpl[];
  readonly topics: readonly unknown[];
  readonly jobs: readonly unknown[];
  /** Drops the snapshots held; the engine drain calls it. */
  stop(): void;
}

export function createTopologyModule(deps: TopologyModuleDeps): EngineModule {
  const snapshots = createSnapshotReader(deps);
  return {
    id: 'svc-topology',
    actions: createActions({ ...deps, snapshots }),
    topics: [],
    jobs: [],
    stop: () => {
      snapshots.stop();
    },
  };
}
