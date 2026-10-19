// The plan-purity manifest (blueprint 2.2): every action the product registers, with an input that
// passes its schema, so the harness can run `plan()` against write ports that throw.
//
// There is one entry per `implementAction(...)` call site. `repository.spec.ts` compares this list
// with the call sites it finds in the source, so an action that is not listed fails the build:
// adding an action means adding it here. `pnpm nx g @app/generators:action` appends the entry; when
// an action becomes a factory that needs ports, build it here with fakes from `@app/testkit`.
import type { PlanPuritySample } from '@app/kernel';
import { createLayoutsGetAction } from '@app/svc-workspace';
import { createWorkspaceFakeDeps } from '@app/svc-workspace';
import { createLayoutsPutAction } from '@app/svc-workspace';
import { createViewsListAction } from '@app/svc-workspace';
import { createViewsCreateAction } from '@app/svc-workspace';
import { createViewsDeleteAction } from '@app/svc-workspace';
import { createSettingsGetAction } from '@app/svc-workspace';
import { createSettingsPutAction } from '@app/svc-workspace';
import { createKeybindingsGetAction } from '@app/svc-workspace';
import { createKeybindingsPutAction } from '@app/svc-workspace';
import { createDiagnosticsBundleAction } from '@app/svc-ops';
import { FAKE_FILE_TOKEN, createOpsFakeDeps } from '@app/svc-ops';

export interface RegisteredAction extends PlanPuritySample {
  /** The module that calls `implementAction(...)`, repository-relative. */
  path: string;
}

const manifest: RegisteredAction[] = [
  {
    path: 'libs/engine/svc-workspace/src/actions/layouts-get.ts',
    impl: createLayoutsGetAction(createWorkspaceFakeDeps()),
    input: { cid: 'c1' },
  },
  {
    path: 'libs/engine/svc-workspace/src/actions/layouts-put.ts',
    impl: createLayoutsPutAction(createWorkspaceFakeDeps()),
    input: { cid: 'c1', layout: {} },
  },
  {
    path: 'libs/engine/svc-workspace/src/actions/views-list.ts',
    impl: createViewsListAction(createWorkspaceFakeDeps()),
    input: {},
  },
  {
    path: 'libs/engine/svc-workspace/src/actions/views-create.ts',
    impl: createViewsCreateAction(createWorkspaceFakeDeps()),
    input: { name: 'Busy queues', kind: 'queues', definition: {} },
  },
  {
    path: 'libs/engine/svc-workspace/src/actions/views-delete.ts',
    impl: createViewsDeleteAction(createWorkspaceFakeDeps()),
    input: { viewId: 'sample' },
  },
  {
    path: 'libs/engine/svc-workspace/src/actions/settings-get.ts',
    impl: createSettingsGetAction(createWorkspaceFakeDeps()),
    input: {},
  },
  {
    path: 'libs/engine/svc-workspace/src/actions/settings-put.ts',
    impl: createSettingsPutAction(createWorkspaceFakeDeps()),
    input: { settings: { timeDisplay: 'utc' } },
  },
  {
    path: 'libs/engine/svc-workspace/src/actions/keybindings-get.ts',
    impl: createKeybindingsGetAction(createWorkspaceFakeDeps()),
    input: {},
  },
  {
    path: 'libs/engine/svc-workspace/src/actions/keybindings-put.ts',
    impl: createKeybindingsPutAction(createWorkspaceFakeDeps()),
    input: { bindings: {} },
  },
  {
    path: 'libs/engine/svc-ops/src/actions/diagnostics-bundle.ts',
    impl: createDiagnosticsBundleAction(createOpsFakeDeps()),
    input: { fileToken: FAKE_FILE_TOKEN },
  },
];

export function registeredActions(): RegisteredAction[] {
  return [...manifest];
}
