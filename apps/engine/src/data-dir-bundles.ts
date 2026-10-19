// Where a diagnostics bundle goes in a mode that has no native save dialog (local web mode): a fixed
// directory inside the data directory. The token names a file inside it and nothing else: it is
// checked against the token pattern (no separator, no dot, so no way out of the directory), the file
// is created exclusively (nothing is overwritten and a token is good once), and the directory is
// private to the user. Desktop saves through `PlatformBridge.pickSaveTarget`, which the main process
// resolves (M2); until then the desktop mode has no sink and registers no `diagnostics.bundle`.
import { mkdir, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { FileTokenSchema } from '@app/contracts';
import type { FileTokenSink } from '@app/svc-ops';

export const BUNDLE_DIR = 'diagnostics';
/** Bundles kept in the directory; the person deletes old ones, the engine never does. */
export const BUNDLES_MAX = 20;

export function createDataDirBundleSink(dataDir: string): FileTokenSink {
  const dir = join(dataDir, BUNDLE_DIR);
  return {
    write: async (fileToken, data) => {
      if (!FileTokenSchema.safeParse(fileToken).success) {
        return 'unknown-token';
      }
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if ((await readdir(dir)).length >= BUNDLES_MAX) {
        throw new Error(
          `The bundle directory already holds ${String(BUNDLES_MAX)} files.`,
        );
      }
      const path = join(dir, `bundle-${fileToken}.json`);
      let file;
      try {
        // 'wx': fail if the file exists, so a token is good once and nothing is replaced.
        file = await open(path, 'wx', 0o600);
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'EEXIST'
        ) {
          return 'unknown-token';
        }
        throw error;
      }
      try {
        await file.writeFile(data);
      } catch (error) {
        // No half a bundle is left behind (the token is spent either way).
        await file.close();
        await unlink(path).catch(() => undefined);
        throw error;
      }
      await file.close();
      return 'written';
    },
  };
}
