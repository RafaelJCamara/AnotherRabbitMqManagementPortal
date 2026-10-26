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

export interface EditorHandle extends EditorDisposable {
  getValue(): string;
  setValue(value: string): void;
  setLanguage(language: EditorLanguage): void;
  setReadOnly(readOnly: boolean): void;
  setMarkers(markers: readonly EditorMarker[]): void;
  onDidChangeValue(listener: (value: string) => void): EditorDisposable;
}

export interface EditorHost {
  /** The host lays the editor out by itself when its container resizes (and stops on dispose). */
  createEditor(container: HTMLElement, options: EditorOptions): EditorHandle;
  /** Monaco's theme is global to the page. */
  setTheme(theme: EditorThemeName): void;
}

/** What the loader hands out. `load()` is single flight; a failure is not cached. */
export interface MonacoLoader {
  load(): Promise<EditorHost>;
}
