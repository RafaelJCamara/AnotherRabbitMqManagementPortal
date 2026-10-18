// Runs the AMQP 0-9-1 contract suite (`adapter-amqp091:contract`, M0-28) against lab brokers:
//
//   node libs/testkit/src/it/run-contract.ts --broker=all
//   node libs/testkit/src/it/run-contract.ts --broker=4.3.6,4.2.9
//
// For each broker version it starts one lab broker (vitest global setup) and runs every spec in
// libs/engine/adapter-amqp091/contract/ against it, once per client library. Like `run-it.ts` it
// needs a Docker daemon and fails loudly without one: a skipped verification would read as a pass.
// Node runs this file directly (erasable TypeScript only).
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadBrokerVersions } from '../lab/versions.ts';

const VERSION = /^\d+\.\d+\.\d+$/;

function parse(argv: readonly string[]): string[] {
  let broker = 'all';
  for (const flag of argv) {
    if (flag.startsWith('--broker=')) {
      broker = flag.slice('--broker='.length);
    } else {
      throw new Error(`unknown option ${flag}`);
    }
  }
  if (broker === 'all') {
    return loadBrokerVersions().map((entry) => entry.version);
  }
  const versions = broker.split(',');
  if (!versions.every((version) => VERSION.test(version))) {
    throw new Error(
      `--broker must be "all" or exact versions such as 4.3.6,4.2.9, got "${broker}"`,
    );
  }
  return versions;
}

let versions: string[];
try {
  versions = parse(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error('usage: run-contract.ts [--broker=all|4.3.6[,4.2.9]]');
  process.exit(2);
}

const docker = spawnSync('docker', ['info'], {
  stdio: 'ignore',
  timeout: 30_000,
});
if (docker.status !== 0) {
  console.error(
    'adapter-amqp091:contract needs a running Docker daemon (docker info failed). Broker tests run on Linux CI.',
  );
  process.exit(1);
}

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const vitest = fileURLToPath(
  new URL('vitest.mjs', import.meta.resolve('vitest/package.json')),
);
const config = 'libs/engine/adapter-amqp091/vitest.contract.config.mts';
const evidence = `${root}dist/contract-evidence`;
mkdirSync(evidence, { recursive: true });

const failed: string[] = [];
for (const version of versions) {
  console.info(
    `\n=== AMQP 0-9-1 contract suite against RabbitMQ ${version} ===`,
  );
  const result = spawnSync(
    process.execPath,
    [vitest, 'run', '--config', config],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        CONTRACT_BROKER_VERSION: version,
        CONTRACT_EVIDENCE_DIR: evidence,
      },
    },
  );
  if (result.status !== 0) failed.push(version);
}

console.info(
  failed.length === 0
    ? `\nThe contract suite passed on ${versions.join(', ')}. Evidence candidates: ${evidence}`
    : `\nThe contract suite FAILED on ${failed.join(', ')}.`,
);
process.exit(failed.length === 0 ? 0 : 1);
