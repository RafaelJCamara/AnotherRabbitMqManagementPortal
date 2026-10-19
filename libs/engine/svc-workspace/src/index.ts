export { createWorkspaceModule } from './module';
export type { WorkspaceModuleDeps } from './deps';
export type { EngineModule } from './module';
// Fakes for the ports of this module, for the architecture manifest and the HTTP specs.
export { createWorkspaceFakeDeps } from './testing';
export { createLayoutsGetAction } from './actions/layouts-get';
export { createLayoutsPutAction } from './actions/layouts-put';
export { createViewsListAction } from './actions/views-list';
export { createViewsCreateAction } from './actions/views-create';
export { createViewsDeleteAction } from './actions/views-delete';
export { createSettingsGetAction } from './actions/settings-get';
export { createSettingsPutAction } from './actions/settings-put';
export { createKeybindingsGetAction } from './actions/keybindings-get';
export { createKeybindingsPutAction } from './actions/keybindings-put';
