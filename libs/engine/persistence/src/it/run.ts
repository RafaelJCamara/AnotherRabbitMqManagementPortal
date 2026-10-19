// `pnpm nx run persistence:it --dialects=sqlite,pg [--pg-versions=16,18]`
// Runs the integration tests of libs/engine/persistence for the chosen dialects. The flags are
// handed to vitest as environment variables, because the Nx Vitest generators do not support
// Vitest 5 (OQ-24) and this keeps the target a plain command.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const KNOWN_DIALECTS = ['sqlite', 'pg'];

/** A list flag. Nx re-serialises `--x=a,b` as `--x="a b"`, so commas, spaces and quotes all split. */
function listFlag(name: string, fallback: string): string[] {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  const text =
    argument === undefined ? fallback : argument.slice(prefix.length);
  return text.split(/[\s,'"]+/).filter((item) => item !== '');
}

const dialects = listFlag('dialects', 'sqlite,pg');
const pgVersions = listFlag('pg-versions', '16,18');
/** `--filter="job store"` runs only the tests whose name contains the text (`nx run jobs:it`). */
const filterArgument = process.argv.find((value) =>
  value.startsWith('--filter='),
);
const filter = filterArgument
  ?.slice('--filter='.length)
  .replace(/^["']|["']$/g, '');

const unknown = dialects.filter((name) => !KNOWN_DIALECTS.includes(name));
if (unknown.length > 0 || dialects.length === 0) {
  console.error(
    `Unknown dialect(s) "${unknown.join(',')}". Use --dialects=sqlite,pg (any non-empty subset).`,
  );
  process.exit(2);
}
if (pgVersions.some((version) => !/^\d+$/.test(version))) {
  console.error(
    '--pg-versions takes major versions, for example --pg-versions=16,18.',
  );
  process.exit(2);
}

const vitest = join(
  dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
  'vitest.mjs',
);
const result = spawnSync(
  process.execPath,
  [
    vitest,
    'run',
    '--config',
    'libs/engine/persistence/vitest.it.config.mts',
    ...(filter === undefined || filter === '' ? [] : ['-t', filter]),
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      PERSISTENCE_IT_DIALECTS: dialects.join(','),
      PERSISTENCE_IT_PG_VERSIONS: pgVersions.join(','),
    },
  },
);
process.exit(result.status ?? 1);
