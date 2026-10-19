// `pnpm nx run adapter-mgmt-http:record-golden` (M0-25): records the golden fixtures from real
// brokers, or with `--check` compares a fresh recording with the committed fixtures.
//
//   node libs/testkit/src/it/run-golden.ts                              every version, writes
//   node libs/testkit/src/it/run-golden.ts --versions=4.3.6 --check     compare, write nothing
//   node libs/testkit/src/it/run-golden.ts --versions=lavinmq
//   node libs/testkit/src/it/run-golden.ts --versions=4.3.6 --modes=stats-off --out=tmp/fixtures
//
// It needs a Docker daemon (RabbitMQ images are built from testing/broker-lab; LavinMQ is pulled by
// digest) and fails loudly without one: a skipped recording would read as a pass. Like `run-it.ts`
// it starts vitest, which resolves the @app/* aliases; the arguments are checked there
// (`golden-record.it.ts`). Node runs this file directly (erasable TypeScript only).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const docker = spawnSync('docker', ['info'], {
  stdio: 'ignore',
  timeout: 30_000,
});
if (docker.status !== 0) {
  console.error(
    'record-golden needs a running Docker daemon (docker info failed). Broker recordings run on Linux CI.',
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
  [vitest, 'run', '--config', config, 'src/it/golden-record.it.ts'],
  {
    stdio: 'inherit',
    env: { ...process.env, GOLDEN_ARGS: JSON.stringify(process.argv.slice(2)) },
  },
);
process.exit(result.status ?? 1);
