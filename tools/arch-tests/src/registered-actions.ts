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
import { createConnectionsCreateAction } from '@app/svc-connections';
import { createConnectionsFakeDeps } from '@app/svc-connections';
import { createConnectionsUpdateAction } from '@app/svc-connections';
import { createConnectionsDeleteAction } from '@app/svc-connections';
import { createConnectionsListAction } from '@app/svc-connections';
import { createConnectionsGetAction } from '@app/svc-connections';
import { createConnectionsTestHttpAction } from '@app/svc-connections';
import { createConnectionsTestAmqpAction } from '@app/svc-connections';
import { createBundlesExportAction } from '@app/svc-connections';
import { createBundlesImportAction } from '@app/svc-connections';
import { createProfileGetAction } from '@app/svc-capabilities';
import { createCapabilitiesFakeDeps } from '@app/svc-capabilities';
import { createProbeRunAction } from '@app/svc-capabilities';
import { createInventoryQueryAction } from '@app/svc-explorer';
import { createExplorerFakeDeps } from '@app/svc-explorer';

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
  {
    path: 'libs/engine/svc-connections/src/actions/connections-create.ts',
    impl: createConnectionsCreateAction(createConnectionsFakeDeps()),
    input: {
      name: 'Orders',
      envClass: 'dev',
      uri: 'amqps://u:p@mq.example:5671/%2Fprod',
    },
  },
  {
    path: 'libs/engine/svc-connections/src/actions/connections-update.ts',
    impl: createConnectionsUpdateAction(createConnectionsFakeDeps()),
    input: { cid: 'c1', name: 'Renamed' },
  },
  {
    path: 'libs/engine/svc-connections/src/actions/connections-delete.ts',
    impl: createConnectionsDeleteAction(createConnectionsFakeDeps()),
    input: { cid: 'c1' },
  },
  {
    path: 'libs/engine/svc-connections/src/actions/connections-list.ts',
    impl: createConnectionsListAction(createConnectionsFakeDeps()),
    input: {},
  },
  {
    path: 'libs/engine/svc-connections/src/actions/connections-get.ts',
    impl: createConnectionsGetAction(createConnectionsFakeDeps()),
    input: { cid: 'c1' },
  },
  {
    path: 'libs/engine/svc-connections/src/actions/connections-test-http.ts',
    impl: createConnectionsTestHttpAction(createConnectionsFakeDeps()),
    input: { cid: 'c1' },
  },
  {
    path: 'libs/engine/svc-connections/src/actions/connections-test-amqp.ts',
    impl: createConnectionsTestAmqpAction(createConnectionsFakeDeps()),
    input: { cid: 'c1' },
  },
  {
    path: 'libs/engine/svc-connections/src/actions/bundles-export.ts',
    impl: createBundlesExportAction(createConnectionsFakeDeps()),
    input: {},
  },
  {
    path: 'libs/engine/svc-connections/src/actions/bundles-import.ts',
    impl: createBundlesImportAction(createConnectionsFakeDeps()),
    input: {
      bundle: {
        format: 'connection-bundle',
        version: 1,
        exportedAt: 1,
        secretsIncluded: false,
        profiles: [],
      },
    },
  },
  {
    path: 'libs/engine/svc-capabilities/src/actions/profile-get.ts',
    impl: createProfileGetAction(createCapabilitiesFakeDeps()),
    input: { cid: 'c1' },
  },
  {
    path: 'libs/engine/svc-capabilities/src/actions/probe-run.ts',
    impl: createProbeRunAction(createCapabilitiesFakeDeps()),
    input: { cid: 'c1' },
  },
  {
    path: 'libs/engine/svc-explorer/src/actions/inventory-query.ts',
    impl: createInventoryQueryAction(createExplorerFakeDeps()),
    input: { cid: 'c1', kind: 'queues', window: { offset: 0, limit: 200 } },
  },
];

export function registeredActions(): RegisteredAction[] {
  return [...manifest];
}
