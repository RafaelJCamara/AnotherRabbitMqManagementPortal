// Local web mode (blueprint 1.2): the engine binds 127.0.0.1, serves the web build, and is reached
// with a launch token that exists only in this process and in the URL the console prints.
//
//   storage      one SQLite file in the data directory, under the data-directory lock
//   key wraps    [file KEK when --kek-file is given, OS keyring, passphrase] (OQ-300). The keyring
//                binding is not in the catalog yet (OQ-301), so its backend reports `none` and the
//                vault falls to the passphrase; nothing can type one yet, so without a KEK file the
//                vault stays locked and plans and jobs fail closed (OQ-351).
//   auth         the launch token; the one UI principal may do everything, others nothing (A-11)
//   listener     127.0.0.1 and the --port flag (0: the system picks); a bind anywhere else is refused.
//                `APP_RUNTIME=container` is the one exception (ADR-016): 0.0.0.0:8765 inside the
//                container, token mandatory, banner with the loopback `docker run -p`. The rules
//                are in `web-binding.ts`.
//   jobs         the lock makes this the only engine on the database: running jobs are interrupted
//                at start, and none resumes by itself
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
import type { ModeFactory } from './types.ts';
import {
  containerNotice,
  launchUrl,
  resolveWebBinding,
  type WebBinding,
} from './web-binding.ts';

/** No native keyring binding is bundled: report the OS store as absent so the wrap is skipped. */
const noKeyring: KeyringBackend = {
  kind: 'none',
  get: () => Promise.resolve(null),
  set: () => Promise.reject(new Error('No OS keyring is available.')),
};

export const createLocalMode: ModeFactory = (host) => {
  let binding: WebBinding;
  try {
    binding = resolveWebBinding(host.args, host.env);
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new Error('refused'),
    );
  }
  const { dataDir, token } = binding;
  const container = binding.runtime === 'container';

  const wraps: KeyWrap[] = [
    ...(binding.kekFile === undefined
      ? []
      : [createFileKekWrap({ path: binding.kekFile })]),
    createKeyringWrap({ backend: noKeyring }),
    createPassphraseWrap(),
  ];
  const webBuild = join(host.bundleDir, '..', 'web', 'browser');
  const uiRoot =
    binding.uiDir ??
    (existsSync(join(webBuild, 'index.html')) ? webBuild : undefined);
  // Which source made the token, never the token (I-10).
  host.logger.info(
    {
      event: 'engine.web.binding',
      runtime: binding.runtime,
      bind: binding.host,
      authSource: token.source,
      publicOrigins: binding.publicOrigins.length,
    },
    'web binding',
  );

  return Promise.resolve({
    profile: {
      mode: 'local',
      storage: {
        open: () => openSqlite({ path: join(dataDir, 'engine.db') }),
        backupDir: join(dataDir, 'backups'),
        lockDir: dataDir,
      },
      vault: { wraps },
      authenticators: [createLocalTokenAuth(token.value)],
      authorizer: allowUiPrincipals(),
      canSubscribe: (principal) => isUiPrincipal(principal),
      listener: {
        host: binding.host,
        port: binding.port,
        // ADR-016: a wildcard bind is the container's namespace, never a LAN exposure.
        ...(container ? { containerNamespace: true as const } : {}),
      },
      ...(binding.publicOrigins.length === 0
        ? {}
        : { publicOrigins: binding.publicOrigins }),
      ...(uiRoot === undefined ? {} : { uiRoots: [uiRoot] }),
      jobs: { recovery: 'interrupt-all-running', autoResume: 'never' },
      // Bundles go to <data dir>/diagnostics; the launch token is removed from them.
      diagnostics: {
        files: createDataDirBundleSink(dataDir),
        secretValues: () => [token.value],
      },
    },
    launchUrl: (address) => launchUrl(binding, address),
    ...(container
      ? { notice: (address) => containerNotice(binding, address) }
      : {}),
    openOnReady: binding.open,
  });
};
