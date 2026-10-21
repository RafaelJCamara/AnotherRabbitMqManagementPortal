export { createExplorerModule } from './module';
export type { ExplorerModuleDeps } from './deps';
export type { ExplorerModule, ExplorerTopicBinding } from './module';
// Fakes for the ports of this module, for the architecture manifest and the HTTP specs.
export { createExplorerFakeDeps } from './testing';
export { createInventoryQueryAction } from './actions/inventory-query';
export { createOverviewGetAction } from './actions/overview-get';
export { createSearchQueryAction } from './actions/search-query';
// The sweeper, for the lab run (libs/testkit, svc-explorer:it), which needs its real clock and the
// outcome of a sweep. The module owns its own; nothing else should create one.
export { createSweeper } from './internal/sweeper';
export type { Sweeper, SweepOutcome } from './internal/sweeper';
