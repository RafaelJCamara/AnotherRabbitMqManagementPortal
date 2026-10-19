export { createConnectionsModule } from './module.ts';
export type { ConnectionsModuleDeps } from './deps.ts';
export type { EngineModule } from './module.ts';
// Fakes for the ports of this module, for the architecture manifest and the HTTP specs.
export { createConnectionsFakeDeps } from './testing.ts';
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
