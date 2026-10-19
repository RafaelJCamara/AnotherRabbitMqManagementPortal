// The contract registry. A new action or topic is added here, then `pnpm nx run contracts:api-docs`
// regenerates the committed specs; `contracts:api-docs-check` fails on any drift.
import type { Registry } from '../kit/invariants.ts';
import { metaGet } from './meta.ts';
import { opsArm, opsDisarm } from './ops.ts';
import { layoutsGet } from './layouts-get.ts';
import { layoutsPut } from './layouts-put.ts';
import { viewsList } from './views-list.ts';
import { viewsCreate } from './views-create.ts';
import { viewsDelete } from './views-delete.ts';
import { settingsGet } from './settings-get.ts';
import { settingsPut } from './settings-put.ts';
import { keybindingsGet } from './keybindings-get.ts';
import { keybindingsPut } from './keybindings-put.ts';
import { diagnosticsBundle } from './diagnostics-bundle.ts';
import { connectionsCreate } from './connections-create.ts';
import { connectionsUpdate } from './connections-update.ts';
import { connectionsDelete } from './connections-delete.ts';
import { connectionsList } from './connections-list.ts';
import { connectionsGet } from './connections-get.ts';
import { connectionsTestHttp } from './connections-test-http.ts';
import { connectionsTestAmqp } from './connections-test-amqp.ts';
import { bundlesExport } from './bundles-export.ts';
import { bundlesImport } from './bundles-import.ts';

export const registry: Registry = {
  actions: [
    metaGet,
    opsArm,
    opsDisarm,
    layoutsGet,
    layoutsPut,
    viewsList,
    viewsCreate,
    viewsDelete,
    settingsGet,
    settingsPut,
    keybindingsGet,
    keybindingsPut,
    diagnosticsBundle,
    connectionsCreate,
    connectionsUpdate,
    connectionsDelete,
    connectionsList,
    connectionsGet,
    connectionsTestHttp,
    connectionsTestAmqp,
    bundlesExport,
    bundlesImport,
  ],
  topics: [],
};
