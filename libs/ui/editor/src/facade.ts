/**
 * The narrow types the rest of the application sees. No Monaco type or value crosses this file:
 * a feature talks to an `EditorHost`, and only the Monaco entry (slice A2) knows what is behind it.
 * The shape of `EditorHost` is settled by the components of slice B; today it is just enough for the
 * loader to be typed and for specs to provide a fake.
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

export interface EditorHandle extends EditorDisposable {
  getValue(): string;
  setValue(value: string): void;
  setLanguage(language: EditorLanguage): void;
  setReadOnly(readOnly: boolean): void;
  setMarkers(markers: readonly EditorMarker[]): void;
  onDidChangeValue(listener: (value: string) => void): EditorDisposable;
}

export interface EditorHost {
  createEditor(container: HTMLElement, options: EditorOptions): EditorHandle;
}

/** What the loader hands out. `load()` is single flight; a failure is not cached. */
export interface MonacoLoader {
  load(): Promise<EditorHost>;
}
