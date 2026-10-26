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
import { profileGet } from './profile-get.ts';
import { probeRun } from './probe-run.ts';
import { inventoryQuery } from './inventory-query.ts';
import { overviewGet } from './overview-get.ts';
import { explorerWindowTopic } from './explorer-window-topic.ts';
import { searchQuery } from './search-query.ts';
import { metricsQuery } from './metrics-query.ts';
import { metricsForecast } from './metrics-forecast.ts';
import { metricsLiveTopic } from './metrics-live-topic.ts';
import { queuesEffectiveConfig } from './queues-effective-config.ts';
import { topologyGraph } from './topology-graph.ts';
import { topologySubgraph } from './topology-subgraph.ts';
import { routingSimulate } from './routing-simulate.ts';
import { routingDeadLetter } from './routing-dead-letter.ts';
import { routingDlxSources } from './routing-dlx-sources.ts';
import { messagesPublish } from './messages-publish.ts';
import { messagesPublishHistoryList } from './messages-publish-history-list.ts';
import { messagesPublishHistoryGet } from './messages-publish-history-get.ts';

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
    profileGet,
    probeRun,
    inventoryQuery,
    overviewGet,
    searchQuery,
    metricsQuery,
    metricsForecast,
    queuesEffectiveConfig,
    topologyGraph,
    topologySubgraph,
    routingSimulate,
    routingDeadLetter,
    routingDlxSources,
    messagesPublish,
    messagesPublishHistoryList,
    messagesPublishHistoryGet,
  ],
  topics: [explorerWindowTopic, metricsLiveTopic],
};
