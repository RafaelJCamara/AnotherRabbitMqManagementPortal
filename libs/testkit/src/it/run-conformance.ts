// `conformance:test` (M0-37): the specs of apps/conformance, with the live leg of the three-way
// assertion when brokers are asked for.
//
//   node libs/testkit/src/it/run-conformance.ts [--versions=4.3.6[,4.2.9]] [--grep=CF-SMOKE]
//        [--shard=1/4] [--strict] [--non-blocking=4.0.9]
//
// Without --versions it runs every spec (no Docker): the cells compare the recorded evidence with
// the registry, and an unverified cell is skipped, not green. With --versions it starts one lab
// broker per version (needs a Docker daemon, fails loudly without one, like `conformance:record`),
// hands it to the lab-cell specs in LAB_BROKER and runs only those, live. --strict turns an
// unverified cell into a failure (the release gate). A version in --non-blocking (default 4.0.9,
// end-of-life) is run and shown, and its failures do not fail the command. This file records no
// evidence and never touches testing/lab-evidence/** (I-14, A-20). Node runs it directly
// (erasable TypeScript only).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startBroker } from '../broker-lab.ts';
import { loadBrokerVersions } from '../lab/versions.ts';

interface Options {
  readonly versions: string[] | undefined;
  readonly grep: string | undefined;
  readonly shard: string | undefined;
  readonly strict: boolean;
  readonly nonBlocking: string[];
}

export function parse(
  argv: readonly string[],
  known: readonly string[],
): Options {
  let versions: string[] | undefined;
  let grep: string | undefined;
  let shard: string | undefined;
  let strict = false;
  let nonBlocking = ['4.0.9'];
  for (const flag of argv) {
    if (flag === '--strict') {
      strict = true;
      continue;
    }
    const match = /^--(versions|grep|shard|non-blocking)=(.*)$/.exec(flag);
    if (!match?.[1] || match[2] === undefined) {
      throw new Error(`unknown option ${flag}`);
    }
    const value = match[2];
    if (match[1] === 'versions') versions = value.split(',');
    else if (match[1] === 'grep') grep = value;
    else if (match[1] === 'shard') shard = value;
    else nonBlocking = value === '' ? [] : value.split(',');
  }
  for (const version of [...(versions ?? []), ...nonBlocking]) {
    if (!known.includes(version)) {
      throw new Error(
        `"${version}" is not a lab version (${known.join(', ')})`,
      );
    }
  }
  if (grep !== undefined && !/^[\w .*:-]+$/.test(grep)) {
    throw new Error(
      '--grep may contain letters, digits, space and _ . * : - only',
    );
  }
  if (shard !== undefined && !/^[1-9]\d*\/[1-9]\d*$/.test(shard)) {
    throw new Error('--shard must be i/n, for example 1/4');
  }
  return { versions, grep, shard, strict, nonBlocking };
}

/** Whether a failing run on ersion fails the command: every version does, but the non-blocking ones. */
export const blocks = (
  version: string,
  nonBlocking: readonly string[],
): boolean => !nonBlocking.includes(version);

const root = fileURLToPath(new URL('../../../../', import.meta.url));

interface Reported {
  cfId: string;
  cellId: string | null;
  version: string;
  verdict: 'pass' | 'fail' | 'unverified';
  reasons: string[];
}

/** What the specs reported (one JSON line per result): the counts, and every result that is not a pass. */
export function summarise(text: string): string {
  const results = text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Reported);
  const count = (verdict: Reported['verdict']): number =>
    results.filter((result) => result.verdict === verdict).length;
  return [
    `conformance:test: ${String(results.length)} result(s): ${String(count('pass'))} pass, ${String(count('fail'))} fail, ${String(count('unverified'))} unverified`,
    ...results
      .filter((result) => result.verdict !== 'pass')
      .map(
        (result) =>
          `  ${result.verdict} ${result.cfId} on ${result.version} (cell ${result.cellId ?? 'none'}): ${result.reasons.join('; ')}`,
      ),
  ].join('\n');
}

/** The arguments after the vitest entry file. */
export function vitestArgs(
  options: Options,
  files: readonly string[],
): string[] {
  return [
    'run',
    '--config',
    'apps/conformance/vitest.config.mts',
    ...(options.grep === undefined ? [] : ['-t', options.grep]),
    ...(options.shard === undefined ? [] : ['--shard', options.shard]),
    ...files,
  ];
}

/** What the specs read from the environment (see assert/cell-spec.ts). */
export const vitestEnv = (
  options: Options,
  env: Record<string, string>,
  report: string,
): Record<string, string> => ({
  ...env,
  CONFORMANCE_REPORT: report,
  ...(options.strict ? { CONFORMANCE_STRICT: '1' } : {}),
});

function vitest(
  options: Options,
  files: string[],
  env: Record<string, string>,
): number {
  const entry = fileURLToPath(
    new URL('vitest.mjs', import.meta.resolve('vitest/package.json')),
  );
  const folder = mkdtempSync(join(tmpdir(), 'conformance-report-'));
  const report = join(folder, 'results.jsonl');
  const result = spawnSync(
    process.execPath,
    [entry, ...vitestArgs(options, files)],
    {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, ...vitestEnv(options, env, report) },
    },
  );
  if (existsSync(report)) console.info(summarise(readFileSync(report, 'utf8')));
  rmSync(folder, { recursive: true, force: true });
  return result.status ?? 1;
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  let options: Options;
  try {
    options = parse(
      process.argv.slice(2),
      loadBrokerVersions().map((entry) => entry.version),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(
      'usage: run-conformance.ts [--versions=4.3.6[,4.2.9]] [--grep=CF-SMOKE] [--shard=1/4] [--strict] [--non-blocking=4.0.9]',
    );
    process.exit(2);
  }

  if (options.versions === undefined) {
    process.exit(vitest(options, [], {}) === 0 ? 0 : 1);
  }

  const docker = spawnSync('docker', ['info'], {
    stdio: 'ignore',
    timeout: 30_000,
  });
  if (docker.status !== 0) {
    console.error(
      'conformance:test --versions needs a running Docker daemon (docker info failed). Broker tests run on Linux CI.',
    );
    process.exit(1);
  }

  let failed = false;
  for (const version of options.versions) {
    console.info(`\n=== conformance:test on RabbitMQ ${version} ===`);
    const broker = await startBroker({ version });
    try {
      const status = vitest(options, ['src/cells'], {
        CONFORMANCE_VERSIONS: version,
        LAB_BROKER: JSON.stringify({
          version: broker.version,
          digest: broker.digest,
          amqp: broker.amqp,
          http: broker.http,
          container: broker.container,
          credentials: broker.credentials,
        }),
      });
      if (status !== 0) {
        if (blocks(version, options.nonBlocking)) failed = true;
        else {
          console.warn(
            `conformance:test: RabbitMQ ${version} failed; it is non-blocking, so the command does not fail for it.`,
          );
        }
      }
    } finally {
      await broker.stop();
    }
  }
  process.exit(failed ? 1 : 0);
}
