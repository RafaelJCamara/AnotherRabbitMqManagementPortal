// The composition root calls createExplorerModule with the ports this service needs and
// registers what the module returns. A service never imports another service or an adapter:
// cross-service needs are ports wired in the composition root.
import { explorerWindowTopic, type TopicDef } from '@app/contracts';
import type { ActionImpl } from '@app/kernel';
import type { TopicSource } from '@app/live';

import { createActions } from './actions';
import type { ExplorerModuleDeps } from './deps';
import { createBindingsStore } from './internal/bindings';
import { createSweeper } from './internal/sweeper';
import { createWindowSource } from './internal/window-source';
import { jobs } from './jobs';
import { topics } from './topics';

export interface ExplorerTopicBinding {
  readonly def: TopicDef;
  readonly source: TopicSource<unknown, unknown>;
}

/** What the composition root registers (not wired into `coreModules` yet: M0-48 spec Q-17, OQ-472). */
export interface ExplorerModule {
  readonly id: 'svc-explorer';
  readonly actions: readonly ActionImpl[];
  readonly topics: readonly TopicDef[];
  /** The composition root registers each with the hub's TopicRegistry (not wired yet: OQ-669). */
  readonly topicSources: readonly ExplorerTopicBinding[];
  readonly jobs: readonly unknown[];
  /** Ends every topic subscription and stops every sweep; the engine drain calls it. */
  stop(): Promise<void>;
}

export function createExplorerModule(deps: ExplorerModuleDeps): ExplorerModule {
  const sweeper = createSweeper(deps);
  const bindings = createBindingsStore(deps);
  const windowSource = createWindowSource({ ...deps, sweeper });
  return {
    id: 'svc-explorer',
    actions: createActions({ ...deps, sweeper, bindings }),
    topics,
    topicSources: [{ def: explorerWindowTopic, source: windowSource }],
    jobs,
    stop: async () => {
      windowSource.stop();
      bindings.stop();
      await sweeper.stop();
    },
  };
}
