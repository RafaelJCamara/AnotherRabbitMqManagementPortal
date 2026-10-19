// One implementAction per file in this directory. The action generator lists each factory here;
// the module calls every one with its ports.
import type { ActionImpl } from '@app/kernel';

import type { OpsModuleDeps } from '../deps';
import { createDiagnosticsBundleAction } from './diagnostics-bundle';

export const actionFactories: readonly ((deps: OpsModuleDeps) => ActionImpl)[] =
  [createDiagnosticsBundleAction];

export function createActions(deps: OpsModuleDeps): readonly ActionImpl[] {
  return actionFactories.map((create) => create(deps));
}
