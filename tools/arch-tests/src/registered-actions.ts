// The plan-purity manifest (blueprint 2.2): every action the product registers, with an input that
// passes its schema, so the harness can run `plan()` against write ports that throw.
//
// There is one entry per `implementAction(...)` call site. `repository.spec.ts` compares this list
// with the call sites it finds in the source, so an action that is not listed fails the build:
// adding an action means adding it here (the action generator, M0-35, appends the entry).
import type { PlanPuritySample } from '@app/kernel';

export interface RegisteredAction extends PlanPuritySample {
  /** The module that calls `implementAction(...)`, repository-relative. */
  path: string;
}

export function registeredActions(): RegisteredAction[] {
  return [];
}
