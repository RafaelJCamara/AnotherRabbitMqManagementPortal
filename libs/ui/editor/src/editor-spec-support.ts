// A recording fake of the editor host for component specs. Like Monaco, a fake editor tells its
// listeners about a programmatic `setValue` too, so a component that echoes would be caught.
import { type ComponentFixture } from '@angular/core/testing';
import type { Provider } from '@angular/core';
import type {
  DiffEditorHandle,
  DiffEditorOptions,
  EditorHandle,
  EditorHost,
  EditorLanguage,
  EditorMarker,
  EditorOptions,
  EditorThemeName,
  SchemaEntry,
} from './facade';
import { MONACO_LOADER } from './loader';

export interface FakeEditor extends EditorHandle {
  readonly options: EditorOptions;
  readonly container: HTMLElement;
  value: string;
  language: EditorLanguage;
  readOnly: boolean;
  markers: readonly EditorMarker[];
  disposed: number;
  /** Calls of `setValue`, which a person typing does not make. */
  sets: number;
  listenersAdded: number;
  listenersDisposed: number;
  /** What a person typing does. */
  type(text: string): void;
}

export interface FakeDiff extends DiffEditorHandle {
  readonly options: DiffEditorOptions;
  original: string;
  modified: string;
  language: EditorLanguage;
  disposed: number;
  sets: number;
  listenersAdded: number;
  listenersDisposed: number;
  type(text: string): void;
}

export interface FakeHost extends EditorHost {
  readonly editors: FakeEditor[];
  readonly diffs: FakeDiff[];
  readonly themes: EditorThemeName[];
  /** Every list `setSchemas` was given, in order. */
  readonly schemaCalls: (readonly SchemaEntry[])[];
}

/** `normalize` is what an editor does to text it is given (Monaco rewrites line endings). */
export function fakeHost(
  normalize: (text: string) => string = (text) => text,
): FakeHost {
  const editors: FakeEditor[] = [];
  const diffs: FakeDiff[] = [];
  const themes: EditorThemeName[] = [];
  const schemaCalls: (readonly SchemaEntry[])[] = [];
  return {
    editors,
    diffs,
    themes,
    schemaCalls,
    schemas: { setSchemas: (entries) => schemaCalls.push(entries) },
    setTheme: (theme) => themes.push(theme),
    createEditor(container, options) {
      const listeners = new Set<(value: string) => void>();
      const editor: FakeEditor = {
        options,
        container,
        modelUri: `inmemory://model/${String(editors.length + 1)}`,
        value: options.value,
        language: options.language,
        readOnly: options.readOnly,
        markers: [],
        disposed: 0,
        sets: 0,
        listenersAdded: 0,
        listenersDisposed: 0,
        getValue: () => editor.value,
        setValue: (value) => {
          editor.sets++;
          editor.value = normalize(value);
          listeners.forEach((listener) => {
            listener(editor.value);
          });
        },
        setLanguage: (language) => (editor.language = language),
        setReadOnly: (readOnly) => (editor.readOnly = readOnly),
        setMarkers: (markers) => (editor.markers = markers),
        onDidChangeValue: (listener) => {
          listeners.add(listener);
          editor.listenersAdded++;
          return {
            dispose: () => {
              editor.listenersDisposed++;
              listeners.delete(listener);
            },
          };
        },
        dispose: () => editor.disposed++,
        type: (text) => {
          editor.value = text;
          listeners.forEach((listener) => {
            listener(text);
          });
        },
      };
      editors.push(editor);
      return editor;
    },
    createDiffEditor(_container, options) {
      const listeners = new Set<(value: string) => void>();
      const diff: FakeDiff = {
        options,
        original: options.original,
        modified: options.modified,
        language: options.language,
        disposed: 0,
        sets: 0,
        listenersAdded: 0,
        listenersDisposed: 0,
        getModified: () => diff.modified,
        setOriginal: (value) => (diff.original = value),
        setModified: (value) => {
          diff.sets++;
          diff.modified = normalize(value);
          listeners.forEach((listener) => {
            listener(diff.modified);
          });
        },
        setLanguage: (language) => (diff.language = language),
        onDidChangeModified: (listener) => {
          listeners.add(listener);
          diff.listenersAdded++;
          return {
            dispose: () => {
              diff.listenersDisposed++;
              listeners.delete(listener);
            },
          };
        },
        dispose: () => diff.disposed++,
        type: (text) => {
          diff.modified = text;
          listeners.forEach((listener) => {
            listener(text);
          });
        },
      };
      diffs.push(diff);
      return diff;
    },
  };
}

/** Provides a loader that resolves to the given host at once. */
export function provideFakeLoader(host: EditorHost): Provider {
  return {
    provide: MONACO_LOADER,
    useValue: { load: () => Promise.resolve(host) },
  };
}

/** Runs change detection and the lazy load to the end. */
export async function settle(
  fixture: ComponentFixture<unknown>,
): Promise<void> {
  for (let round = 0; round < 3; round++) {
    fixture.detectChanges();
    await fixture.whenStable();
    await Promise.resolve();
  }
}

/** The `index`th item, or a failure that names the missing one (the specs use no `!`). */
export function pick<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at ${String(index)}`);
  return item;
}
