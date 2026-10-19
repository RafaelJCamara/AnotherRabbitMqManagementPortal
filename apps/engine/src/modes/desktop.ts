// Desktop mode (blueprint 1.1): the engine is a utility process of the Electron main process. It
// takes everything it needs from `ctl:init` (the data directory and the data key main unwrapped
// with safeStorage), has no TCP listener, and is reached only through the MessagePort tunnel
// (M0-34), which authenticates by a per-boot carrier secret.
//
//   storage      one SQLite file under the data directory of `ctl:init`, under the data-dir lock
//   key wraps    [ctl-delivered] (OQ-300). With no key delivered (Linux without a protected
//                backend) the vault stays locked until a master password flow exists.
//   auth         the carrier secret, generated here; without the tunnel nothing can present it,
//                so until M0-34 no request authenticates (fail closed)
//   listener     none
//   jobs         as local mode: the lock makes this the only engine on the database
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { allowUiPrincipals, isUiPrincipal } from '@app/kernel';
import { openSqlite } from '@app/persistence';
import { createCtlDeliveredWrap } from '@app/secrets';
import { createCarrierAuth } from '@app/transport';

import { UsageError } from '../entry/args.ts';
import type { ModeFactory } from './types.ts';

/** How long to wait for main's `ctl:init`; the engine is useless without it. */
export const INIT_TIMEOUT_MS = 10_000;

export const createDesktopMode: ModeFactory = async (host) => {
  const { ctl } = host;
  if (ctl === undefined) {
    throw new UsageError(
      'Desktop mode needs the desktop main process: there is no control channel.',
    );
  }
  const init = await ctl.next('init', INIT_TIMEOUT_MS);
  const dataDir = init.paths.data;
  const dek = init.dek;

  return {
    profile: {
      mode: 'desktop',
      storage: {
        open: () => openSqlite({ path: join(dataDir, 'engine.db') }),
        backupDir: join(dataDir, 'backups'),
        lockDir: dataDir,
      },
      vault: {
        wraps: [createCtlDeliveredWrap()],
        ...(dek === undefined ? {} : { input: { dek } }),
        // The vault copies what it keeps: zero what main sent as soon as it has been used.
        done: () => {
          dek?.fill(0);
        },
      },
      authenticators: [
        createCarrierAuth(randomBytes(32).toString('base64url')),
      ],
      authorizer: allowUiPrincipals(),
      canSubscribe: (principal) => isUiPrincipal(principal),
      jobs: { recovery: 'interrupt-all-running', autoResume: 'never' },
    },
  };
};
