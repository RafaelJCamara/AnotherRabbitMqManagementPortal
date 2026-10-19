// Launches `conformance:record` (M0-15) against lab brokers:
//
//   node libs/testkit/src/it/run-record.ts --cells=CF-SMOKE-01 --versions=4.3.6 [--out=<folder>]
//
// For each version it starts one lab broker, hands it to `apps/conformance/src/record/cli.ts` as data
// in LAB_BROKER (the recorder does not import the testkit, so it stays independent of it, and it
// checks with Docker that the broker is one this lab created), then removes the broker. Like the
// other runners it needs a Docker daemon and fails loudly without one. This file records nothing
// itself and never touches `testing/lab-evidence/**`: only the recorder writes, and only the
// `conformance-record` workflow may write there (A-20). Node runs it directly (erasable TypeScript
// only).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { startBroker } from '../broker-lab.ts';
import { loadBrokerVersions } from '../lab/versions.ts';

const VERSION = /^\d+\.\d+\.\d+$/;

function parse(argv: readonly string[]): {
  cells: string;
  versions: string[];
  out: string | undefined;
} {
  let cells: string | undefined;
  let versions: string[] | undefined;
  let out: string | undefined;
  for (const flag of argv) {
    const match = /^--(cells|versions|out)=(.+)$/.exec(flag);
    if (!match?.[1] || match[2] === undefined) {
      throw new Error(`unknown option ${flag}`);
    }
    if (match[1] === 'cells') cells = match[2];
    else if (match[1] === 'versions') versions = match[2].split(',');
    else out = match[2];
  }
  if (cells === undefined)
    throw new Error('--cells=<CF-id[,CF-id]> is required');
  const known = loadBrokerVersions().map((entry) => entry.version);
  const wanted = versions ?? known;
  for (const version of wanted) {
    if (!VERSION.test(version) || !known.includes(version)) {
      throw new Error(
        `--versions must be lab versions (${known.join(', ')}), got "${version}"`,
      );
    }
  }
  return { cells, versions: wanted, out };
}

let options: ReturnType<typeof parse>;
try {
  options = parse(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(
    'usage: run-record.ts --cells=CF-SMOKE-01[,CF-X-*] [--versions=4.3.6[,4.2.9]] [--out=<folder>]',
  );
  process.exit(2);
}

const docker = spawnSync('docker', ['info'], {
  stdio: 'ignore',
  timeout: 30_000,
});
if (docker.status !== 0) {
  console.error(
    'conformance:record needs a running Docker daemon (docker info failed). Broker tests run on Linux CI.',
  );
  process.exit(1);
}

const root = fileURLToPath(new URL('../../../../', import.meta.url));
let failed = false;
for (const version of options.versions) {
  console.info(
    `\n=== conformance:record ${options.cells} on RabbitMQ ${version} ===`,
  );
  const broker = await startBroker({ version });
  try {
    const result = spawnSync(
      process.execPath,
      [
        'apps/conformance/src/record/cli.ts',
        `--cells=${options.cells}`,
        ...(options.out === undefined ? [] : [`--out=${options.out}`]),
      ],
      {
        cwd: root,
        stdio: 'inherit',
        env: {
          ...process.env,
          LAB_BROKER: JSON.stringify({
            version: broker.version,
            digest: broker.digest,
            amqp: broker.amqp,
            http: broker.http,
            container: broker.container,
            credentials: broker.credentials,
          }),
        },
      },
    );
    if (result.status !== 0) failed = true;
  } finally {
    await broker.stop();
  }
}
process.exit(failed ? 1 : 0);
