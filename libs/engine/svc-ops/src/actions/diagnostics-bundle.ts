// diagnostics.bundle: Write a redacted local diagnostics bundle to a file the person chose
import { diagnosticsBundle } from '@app/contracts';
import { AppError, implementAction, type ActionImpl } from '@app/kernel';

import type { OpsModuleDeps } from '../deps';
import { buildBundle } from '../internal/bundle';

/** The ports this action reads through: a subset of the module's deps (src/deps.ts). */
export type DiagnosticsBundleDeps = Pick<
  OpsModuleDeps,
  'diagnostics' | 'files' | 'clock'
>;

export const createDiagnosticsBundleAction = (
  deps: DiagnosticsBundleDeps,
): ActionImpl<typeof diagnosticsBundle> =>
  implementAction(diagnosticsBundle, {
    execute: async (input) => {
      const bundle = await buildBundle(deps, { logLines: input.logLines });
      let outcome: Awaited<ReturnType<typeof deps.files.write>>;
      try {
        outcome = await deps.files.write(input.fileToken, bundle.data);
      } catch (error) {
        // The cause stays on the error for the log; the Problem carries a fixed sentence, so a
        // path in the host's message never reaches the renderer.
        throw new AppError('INTERNAL', {
          detail: 'The bundle could not be written to the chosen file.',
          cause: error,
        });
      }
      if (outcome === 'unknown-token') {
        throw new AppError('NOT_FOUND', {
          detail:
            'The save target is unknown or was already used. Choose it again.',
        });
      }
      return {
        bytes: bundle.data.byteLength,
        sha256: bundle.sha256,
        sections: [...bundle.sections],
        omitted: [...bundle.omitted],
      };
    },
  });
