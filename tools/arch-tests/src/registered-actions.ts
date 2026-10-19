// The plan-purity manifest (blueprint 2.2): every action the product registers, with an input that
// passes its schema, so the harness can run `plan()` against write ports that throw.
//
// There is one entry per `implementAction(...)` call site. `repository.spec.ts` compares this list
// with the call sites it finds in the source, so an action that is not listed fails the build:
// adding an action means adding it here. `pnpm nx g @app/generators:action` appends the entry; when
// an action becomes a factory that needs ports, build it here with fakes from `@app/testkit`.
import type { PlanPuritySample } from '@app/kernel';

export interface RegisteredAction extends PlanPuritySample {
  /** The module that calls `implementAction(...)`, repository-relative. */
  path: string;
}

const manifest: RegisteredAction[] = [];

export function registeredActions(): RegisteredAction[] {
  return [...manifest];
}
