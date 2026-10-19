// One implementAction per file in this directory. The action generator lists each factory here;
// the module calls every one with its ports.
import type { ActionImpl } from '@app/kernel';

import type { CapabilitiesModuleDeps } from '../deps';
import { createProfileGetAction } from './profile-get';
import { createProbeRunAction } from './probe-run';

export const actionFactories: readonly ((
  deps: CapabilitiesModuleDeps,
) => ActionImpl)[] = [createProfileGetAction, createProbeRunAction];

export function createActions(
  deps: CapabilitiesModuleDeps,
): readonly ActionImpl[] {
  return actionFactories.map((create) => create(deps));
}
