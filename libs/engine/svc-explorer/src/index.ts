export { createExplorerModule } from './module';
export type { ExplorerModuleDeps } from './deps';
export type { EngineModule } from './module';
// Fakes for the ports of this module, for the architecture manifest and the HTTP specs.
export { createExplorerFakeDeps } from './testing';
export { createInventoryQueryAction } from './actions/inventory-query';
