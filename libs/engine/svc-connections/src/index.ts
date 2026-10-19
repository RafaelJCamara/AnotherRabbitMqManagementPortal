export { createConnectionsModule } from './module.ts';
export type { ConnectionsModuleDeps } from './deps.ts';
export type { EngineModule } from './module.ts';
// Fakes for the ports of this module, for the architecture manifest and the HTTP specs.
export {
  FAKE_PROFILE_ID,
  createConnectionsFakeDeps,
  createFakeProber,
  createFakeSealer,
  createMemoryConnectionStore,
  type ConnectionsFakeDeps,
  type FakeProber,
} from './testing.ts';
// What the actions build on, public for the composition root and for tests: the URI parser, the AMQP
// ports of a broker's listeners, and the scanner a bundle must pass.
export { findSecretsInBundle } from './internal/bundle.ts';
export { amqpPortsFromListeners } from './internal/listeners.ts';
export {
  parseConnectionUri,
  UriError,
  type ParsedUri,
} from './internal/uri.ts';
// The ConnectionManager (M0-43): role pools and budgets. The composition root builds it with the
// adapter's connector and the probe's limits, and hands it to the executor's context.
export {
  createConnectionManager,
  createFakeConnector,
  deriveBudget,
  type BrokerBudgetInput,
  type BrokerLimits,
  type BudgetSource,
  type ConnectionManagerOptions,
  type FakeConnection,
  type FakeConnector,
  type LeaseRole,
  type ManagedConnectionManager,
  type ResolvedBudget,
} from './internal/connection-manager/index.ts';
export { createConnectionsCreateAction } from './actions/connections-create';
export { createConnectionsUpdateAction } from './actions/connections-update';
export { createConnectionsDeleteAction } from './actions/connections-delete';
export { createConnectionsListAction } from './actions/connections-list';
export { createConnectionsGetAction } from './actions/connections-get';
export { createConnectionsTestHttpAction } from './actions/connections-test-http';
export { createConnectionsTestAmqpAction } from './actions/connections-test-amqp';
export { createBundlesExportAction } from './actions/bundles-export';
export { createBundlesImportAction } from './actions/bundles-import';
