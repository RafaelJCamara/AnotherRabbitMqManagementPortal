// Public API of this library. No Monaco type or value is exported.
export { installEditorEnvironment } from './environment/monaco-environment';
export type { EditorRealm } from './environment/realm';
export { EDITOR_WORKER_PATHS } from './environment/trusted-types';
export { CodeEditor, EDITOR_MAX_MARKERS } from './code-editor.component';
export type {
  EditorDisposable,
  EditorHandle,
  EditorHost,
  EditorLanguage,
  EditorMarker,
  EditorOptions,
  EditorThemeName,
  MonacoLoader,
} from './facade';
export {
  createMonacoLoader,
  EditorLoadError,
  loadMonaco,
  MONACO_LOADER,
} from './loader';
export type { EditorLoadErrorCode, MonacoLoaderParts } from './loader';
