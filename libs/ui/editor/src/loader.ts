import { InjectionToken } from '@angular/core';

import { installEditorEnvironment } from './environment/monaco-environment';
import type { EditorHost, MonacoLoader } from './facade';

export type EditorLoadErrorCode =
  /** The policies, `MonacoEnvironment` or the nonce hook could not be installed. */
  | 'environment'
  /** The Monaco chunk did not load or did not start. */
  | 'module'
  /** This build contains no Monaco entry (it arrives with slice A2). */
  | 'not-bundled';

export class EditorLoadError extends Error {
  constructor(
    readonly code: EditorLoadErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'EditorLoadError';
  }
}

export interface MonacoLoaderParts {
  /** Runs before the factory, every attempt. Defaults to `installEditorEnvironment`. */
  readonly install?: () => void;
  /** Imports the Monaco entry and returns its host. */
  readonly importHost: () => Promise<EditorHost>;
}

/**
 * Single flight: concurrent `load()` calls share one attempt and one host. The environment is
 * installed first, every attempt, and the Monaco entry is imported only after that returned, so the
 * order is the order of two calls and not a bundler detail (OQ-1513). A failure rejects with an
 * `EditorLoadError` and is not cached, so the next call tries again; a success is kept.
 */
export function createMonacoLoader(parts: MonacoLoaderParts): MonacoLoader {
  const install =
    parts.install ??
    (() => {
      installEditorEnvironment();
    });
  let settled: Promise<EditorHost> | undefined;
  let pending: Promise<EditorHost> | undefined;

  const attempt = async (): Promise<EditorHost> => {
    try {
      install();
    } catch (cause) {
      throw new EditorLoadError(
        'environment',
        'The editor environment could not be installed.',
        { cause },
      );
    }
    try {
      return await parts.importHost();
    } catch (cause) {
      if (cause instanceof EditorLoadError) throw cause;
      throw new EditorLoadError('module', 'The editor could not be loaded.', {
        cause,
      });
    }
  };

  return {
    load(): Promise<EditorHost> {
      if (settled !== undefined) return settled;
      if (pending !== undefined) return pending;
      const started = attempt().then(
        (host) => {
          settled = Promise.resolve(host);
          pending = undefined;
          return host;
        },
        (error: unknown) => {
          pending = undefined;
          throw error;
        },
      );
      pending = started;
      return started;
    },
  };
}

/**
 * The Monaco entry. Slice A2 replaces this body with `import('./monaco-entry')`; until then the
 * build has no Monaco and says so, so nothing pretends an editor exists.
 */
function importMonacoEntry(): Promise<EditorHost> {
  return Promise.reject(
    new EditorLoadError(
      'not-bundled',
      'This build does not contain the Monaco entry.',
    ),
  );
}

const defaultLoader = createMonacoLoader({ importHost: importMonacoEntry });

/** Loads Monaco once, after its environment. Specs provide `MONACO_LOADER` with a fake host. */
export function loadMonaco(): Promise<EditorHost> {
  return defaultLoader.load();
}

export const MONACO_LOADER = new InjectionToken<MonacoLoader>('MONACO_LOADER', {
  providedIn: 'root',
  factory: () => ({ load: loadMonaco }),
});
