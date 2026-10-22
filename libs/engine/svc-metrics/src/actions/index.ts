// One implementAction per file in this directory. The action generator lists each factory here;
// the module calls every one with its ports and the module's collector.
import type { ActionImpl } from '@app/kernel';

import type { MetricsActionDeps } from '../deps';
import { createMetricsForecastAction } from './metrics-forecast';
import { createMetricsQueryAction } from './metrics-query';

export const actionFactories: readonly ((
  deps: MetricsActionDeps,
) => ActionImpl)[] = [createMetricsQueryAction, createMetricsForecastAction];

export function createActions(deps: MetricsActionDeps): readonly ActionImpl[] {
  return actionFactories.map((create) => create(deps));
}
