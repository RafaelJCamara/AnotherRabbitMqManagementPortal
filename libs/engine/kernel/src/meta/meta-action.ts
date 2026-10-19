// `meta.get`: the engine describes itself (blueprint 3.2, area "Meta"). It reads nothing from a
// broker and changes nothing, so it needs no plan and leaves no audit row (its contract says so).
// The composition root states the version and the delivery mode once; the action only reports them.
import { metaGet, type EngineMode } from '@app/contracts';

import { implementAction } from '../actions/implement-action.ts';
import type { ActionImpl } from '../actions/types.ts';

export interface MetaActionOptions {
  readonly engineVersion: string;
  readonly mode: EngineMode;
}

/** The implementation of `meta.get`, ready to `executor.register(...)`. */
export function createMetaAction(options: MetaActionOptions): ActionImpl {
  const { engineVersion, mode } = options;
  return implementAction(metaGet, {
    execute: () =>
      Promise.resolve({ engineVersion, apiVersion: 'v1' as const, mode }),
  });
}
