// Shared paths and pins of the S-04 CSP spike (M0-20). Throwaway tooling: nothing here ships.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const spikeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = resolve(spikeRoot, '..', '..');

/** Scratch space (gitignored `tmp/`): the libraries are installed here, never into the workspace. */
export const workDir = join(repoRoot, 'tmp', 'csp-spike');
export const depsDir = join(workDir, 'deps');
export const depsModules = join(depsDir, 'node_modules');

/** Built harness (gitignored `dist/`). */
export const distDir = join(repoRoot, 'dist', 'spikes-csp');

/** Existing Angular shell build, used for the "Angular itself under the CSP" scenario. */
export const webDist = join(repoRoot, 'dist', 'apps', 'web', 'browser');

/**
 * The three libraries under test, exact versions (the issue names AG Grid Community 36.2 and
 * Monaco 0.57; elkjs 0.12.0 is the pin in the fact sheet). They are installed outside the pnpm
 * catalog on purpose: promoting them to product dependencies is a maintainer decision (OQ-230).
 */
export const LIBRARIES = {
  'ag-grid-community': '36.2.0',
  'monaco-editor': '0.57.0',
  elkjs: '0.12.0',
};
