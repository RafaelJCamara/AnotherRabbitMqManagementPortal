// The composition root calls createMetricsModule with the ports this service needs and
// registers what the module returns. A service never imports another service or an adapter:
// cross-service needs are ports wired in the composition root.
import { metricsLiveTopic, type TopicDef } from '@app/contracts';
import type { ActionImpl } from '@app/kernel';
import type { TopicSource } from '@app/live';

import { createActions } from './actions';
import type { MetricsModuleDeps } from './deps';
import { createCollector, type Collector } from './internal/collector';
import { createLiveSource } from './internal/window-source';
import { jobs } from './jobs';
import { topics } from './topics';

export interface MetricsTopicBinding {
  readonly def: TopicDef;
  readonly source: TopicSource<unknown, unknown>;
}

/** What the composition root registers. */
export interface MetricsModule {
  readonly id: 'svc-metrics';
  readonly actions: readonly ActionImpl[];
  readonly topics: readonly TopicDef[];
  /** The composition root registers each with the hub's TopicRegistry. */
  readonly topicSources: readonly MetricsTopicBinding[];
  readonly jobs: readonly unknown[];
  /** Ends every topic subscription and stops every collection; the engine drain calls it. */
  stop(): Promise<void>;
}

/** The module over an existing collector (the fakes build one with manual time). */
export function createMetricsModuleWith(
  deps: MetricsModuleDeps,
  collector: Collector,
): MetricsModule {
  const live = createLiveSource({ ...deps, collector });
  return {
    id: 'svc-metrics',
    actions: createActions({ ...deps, collector }),
    topics,
    topicSources: [{ def: metricsLiveTopic, source: live }],
    jobs,
    stop: async () => {
      live.stop();
      await collector.stop();
    },
  };
}

export function createMetricsModule(deps: MetricsModuleDeps): MetricsModule {
  return createMetricsModuleWith(deps, createCollector(deps));
}
