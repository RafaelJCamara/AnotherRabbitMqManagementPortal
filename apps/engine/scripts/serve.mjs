// `pnpm nx run engine:serve`: the built engine in local mode, serving the built web UI.
//
//   node apps/engine/scripts/serve.mjs
//
// The engine prints the launch URL once (`http://127.0.0.1:<port>/#t=<token>`): open it in a browser.
// The token exists only in that process and in that URL; a restart makes a new one.
//
// Everything the engine keeps is under `tmp/engine-data` (git-ignored): the SQLite database, the
// data-directory lock and, beside it, `tmp/engine-data.kek`, a random key-encryption key made on the
// first start so the credential vault opens without a passphrase (OQ-351). It is a local
// development key: delete both to start from nothing.
//
// Environment: ENGINE_PORT (default 4310; 0 asks the system), ENGINE_DATA_DIR (default
// tmp/engine-data), ENGINE_LOG_LEVEL (default info).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..', '..', '..');
const bundle = resolve(root, 'dist', 'apps', 'engine', 'main.mjs');
const webIndex = resolve(root, 'dist', 'apps', 'web', 'browser', 'index.html');
const dataDir = resolve(
  process.env.ENGINE_DATA_DIR ?? resolve(root, 'tmp', 'engine-data'),
);
const kekFile = `${dataDir}.kek`;
const port = process.env.ENGINE_PORT ?? '4310';
const logLevel = process.env.ENGINE_LOG_LEVEL ?? 'info';

if (!existsSync(bundle)) {
  console.error(
    'The engine is not built: run `pnpm nx build engine` (the engine:serve target does it).',
  );
  process.exit(1);
}
if (!existsSync(webIndex)) {
  console.error(
    'The web app is not built: run `pnpm nx build web` (the engine:serve target does it). The engine would start with no UI.',
  );
  process.exit(1);
}

mkdirSync(dataDir, { recursive: true });
if (!existsSync(kekFile)) {
  // 64 hex characters: one of the three formats the file wrap accepts. Private to this user.
  writeFileSync(kekFile, `${randomBytes(32).toString('hex')}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  console.error(`Made a local key-encryption key: ${kekFile}`);
}

console.error(
  `Starting the engine (local mode, 127.0.0.1:${port}, data in ${dataDir}). The launch URL is printed below; open it in a browser.`,
);
const child = spawn(
  process.execPath,
  [
    bundle,
    '--mode=local',
    `--port=${port}`,
    `--data-dir=${dataDir}`,
    `--kek-file=${kekFile}`,
    `--log-level=${logLevel}`,
  ],
  { stdio: 'inherit' },
);
// Ctrl+C reaches the child through the console's process group; this keeps the parent alive until
// the engine has drained and exited, then passes its exit code on.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal === null ? 1 : 0));
});
