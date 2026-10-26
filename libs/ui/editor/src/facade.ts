/**
 * The narrow types the rest of the application sees. No Monaco type or value crosses this file:
 * a feature talks to an `EditorHost`, and only the Monaco entry (slice A2) knows what is behind it.
 * Slice B settled this shape against a fake host; slice A2 implements it with Monaco.
 */

export type EditorLanguage = 'plaintext' | 'json' | 'xml' | 'yaml';

export interface EditorMarker {
  readonly line: number;
  readonly message: string;
  readonly severity: 'error' | 'warning' | 'info';
}

export interface EditorDisposable {
  dispose(): void;
}

export interface EditorOptions {
  readonly value: string;
  readonly language: EditorLanguage;
  readonly readOnly: boolean;
  readonly ariaLabel: string;
}

/** Monaco's four built-in theme names (plain strings; no Monaco type crosses this file). */
export type EditorThemeName = 'vs' | 'vs-dark' | 'hc-black' | 'hc-light';

/** A JSON Schema document. The editor library never reads it; the JSON worker does. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** One schema bound to the models whose URI matches `fileMatch`. */
export interface SchemaEntry {
  readonly uri: string;
  readonly fileMatch: readonly string[];
  readonly schema: JsonSchema;
}

/** Replaces the whole list of schemas the JSON worker validates with (Monaco's options are global). */
export interface SchemaPort {
  setSchemas(entries: readonly SchemaEntry[]): void;
}

export interface EditorHandle extends EditorDisposable {
  /** The URI of the model; the key a schema is bound to. */
  readonly modelUri: string;
  getValue(): string;
  setValue(value: string): void;
  setLanguage(language: EditorLanguage): void;
  setReadOnly(readOnly: boolean): void;
  setMarkers(markers: readonly EditorMarker[]): void;
  onDidChangeValue(listener: (value: string) => void): EditorDisposable;
}

export interface DiffEditorOptions {
  readonly original: string;
  readonly modified: string;
  readonly language: EditorLanguage;
  readonly ariaLabel: string;
  /** The original side is never editable; a host must honour it. */
  readonly originalEditable: false;
}

/** A diff pair. `dispose` disposes the editor and both models, once. */
export interface DiffEditorHandle extends EditorDisposable {
  getModified(): string;
  setOriginal(value: string): void;
  setModified(value: string): void;
  setLanguage(language: EditorLanguage): void;
  onDidChangeModified(listener: (value: string) => void): EditorDisposable;
}

export interface EditorHost {
  /** The host lays the editor out by itself when its container resizes (and stops on dispose). */
  createEditor(container: HTMLElement, options: EditorOptions): EditorHandle;
  createDiffEditor(
    container: HTMLElement,
    options: DiffEditorOptions,
  ): DiffEditorHandle;
  /** Monaco's theme is global to the page. */
  setTheme(theme: EditorThemeName): void;
  readonly schemas: SchemaPort;
}

/** What the loader hands out. `load()` is single flight; a failure is not cached. */
export interface MonacoLoader {
  load(): Promise<EditorHost>;
}
