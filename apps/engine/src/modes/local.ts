// Local web mode (blueprint 1.2): the engine binds 127.0.0.1, serves the web build, and is reached
// with a launch token that exists only in this process and in the URL the console prints.
//
//   storage      one SQLite file in the data directory, under the data-directory lock
//   key wraps    [file KEK when --kek-file is given, OS keyring, passphrase] (OQ-300). The keyring
//                binding is not in the catalog yet (OQ-301), so its backend reports `none` and the
//                vault falls to the passphrase; nothing can type one yet, so without a KEK file the
//                vault stays locked and plans and jobs fail closed (OQ-351).
//   auth         the launch token; the one UI principal may do everything, others nothing (A-11)
//   listener     127.0.0.1 and the --port flag (0: the system picks)
//   jobs         the lock makes this the only engine on the database: running jobs are interrupted
//                at start, and none resumes by itself
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { openSqlite } from '@app/persistence';
import { allowUiPrincipals, isUiPrincipal } from '@app/kernel';
import {
  createFileKekWrap,
  createKeyringWrap,
  createPassphraseWrap,
  type KeyringBackend,
  type KeyWrap,
} from '@app/secrets';
import { createLocalTokenAuth } from '@app/transport';

import { createDataDirBundleSink } from '../data-dir-bundles.ts';
import { UsageError } from '../entry/args.ts';
import type { ModeFactory } from './types.ts';

/** No native keyring binding is bundled: report the OS store as absent so the wrap is skipped. */
const noKeyring: KeyringBackend = {
  kind: 'none',
  get: () => Promise.resolve(null),
  set: () => Promise.reject(new Error('No OS keyring is available.')),
};

export const createLocalMode: ModeFactory = (host) => {
  const { args } = host;
  if (args.dataDir === undefined) {
    return Promise.reject(new UsageError('Local mode needs --data-dir.'));
  }
  const dataDir = args.dataDir;
  const token = randomBytes(32).toString('base64url');

  const wraps: KeyWrap[] = [
    ...(args.kekFile === undefined
      ? []
      : [createFileKekWrap({ path: args.kekFile })]),
    createKeyringWrap({ backend: noKeyring }),
    createPassphraseWrap(),
  ];
  const webBuild = join(host.bundleDir, '..', 'web', 'browser');
  const uiRoot =
    args.uiDir ??
    (existsSync(join(webBuild, 'index.html')) ? webBuild : undefined);

  return Promise.resolve({
    profile: {
      mode: 'local',
      storage: {
        open: () => openSqlite({ path: join(dataDir, 'engine.db') }),
        backupDir: join(dataDir, 'backups'),
        lockDir: dataDir,
      },
      vault: { wraps },
      authenticators: [createLocalTokenAuth(token)],
      authorizer: allowUiPrincipals(),
      canSubscribe: (principal) => isUiPrincipal(principal),
      listener: { host: '127.0.0.1', port: args.port ?? 0 },
      ...(uiRoot === undefined ? {} : { uiRoots: [uiRoot] }),
      jobs: { recovery: 'interrupt-all-running', autoResume: 'never' },
      // Bundles go to <data dir>/diagnostics; the launch token is removed from them.
      diagnostics: {
        files: createDataDirBundleSink(dataDir),
        secretValues: () => [token],
      },
    },
    launchUrl: (address) =>
      `http://${address.host}:${String(address.port)}/#t=${token}`,
  });
};
