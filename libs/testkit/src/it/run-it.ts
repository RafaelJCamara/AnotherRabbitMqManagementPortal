// Runs the integration tests of one project against real lab brokers (`<project>:it`).
//
//   node libs/testkit/src/it/run-it.ts net-dialer --versions=4.3.6
//
// It needs a Docker daemon and fails loudly without one: a verification command that is silently
// skipped would read as a pass. Node runs this file directly (erasable TypeScript only).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [, , project, ...flags] = process.argv;
if (project === undefined || !/^[a-z][a-z0-9-]*$/.test(project)) {
  console.error('usage: run-it.ts <project> [--versions=4.3.6[,4.2.9]]');
  process.exit(2);
}

let versions = '4.3.6';
for (const flag of flags) {
  if (flag.startsWith('--versions=')) {
    versions = flag.slice('--versions='.length);
  } else {
    console.error(`unknown option ${flag}`);
    process.exit(2);
  }
}
if (!/^[0-9]+\.[0-9]+\.[0-9]+(,[0-9]+\.[0-9]+\.[0-9]+)*$/.test(versions)) {
  console.error(
    `--versions must be exact versions such as 4.3.6, got "${versions}"`,
  );
  process.exit(2);
}

const docker = spawnSync('docker', ['info'], {
  stdio: 'ignore',
  timeout: 30_000,
});
if (docker.status !== 0) {
  console.error(
    `${project}:it needs a running Docker daemon (docker info failed). Broker tests run on Linux CI.`,
  );
  process.exit(1);
}

const vitest = fileURLToPath(
  new URL('vitest.mjs', import.meta.resolve('vitest/package.json')),
);
const config = fileURLToPath(
  new URL('../../vitest.it.config.mts', import.meta.url),
);
const result = spawnSync(
  process.execPath,
  [vitest, 'run', '--config', config, `src/it/${project}.it.ts`],
  {
    stdio: 'inherit',
    env: { ...process.env, IT_BROKER_VERSIONS: versions },
  },
);
process.exit(result.status ?? 1);
