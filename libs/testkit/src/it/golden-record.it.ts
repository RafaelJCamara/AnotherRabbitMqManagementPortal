// The recorder of the golden fixtures (M0-25), run by `src/it/run-golden.ts` inside vitest so the
// @app/* aliases resolve. It is not a test of the product: it records real broker answers into
// `testing/fixtures` (or, with `--check`, compares a fresh recording with them). It needs a Docker
// daemon.
import { writeFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { modesFor, parseGoldenArgs } from '../golden/args.ts';
import { compareRecording, writeRecording } from '../golden/files.ts';
import { allTargets, fingerprint, record } from '../golden/record.ts';
import { FIXTURES_DIR } from '../golden/seed.ts';

const argv = JSON.parse(process.env.GOLDEN_ARGS ?? '[]') as string[];
const ONE_HOUR = 3_600_000;

it(
  'records the golden fixtures from the brokers',
  async () => {
    const args = parseGoldenArgs(argv, allTargets());
    const root = args.out ?? FIXTURES_DIR;
    const problems: string[] = [];
    for (const target of args.targets) {
      for (const mode of modesFor(target, args.modes)) {
        console.info(
          `=== ${target.product} ${target.version} (${mode}) ${args.check ? 'check' : 'record'} ===`,
        );
        const recording = await record(target, mode, { log: console.info });
        if (args.check) {
          const differences = compareRecording(root, recording);
          problems.push(...differences);
          console.info(
            differences.length === 0
              ? `  same shape as the committed fixtures (${fingerprint(recording)})`
              : `  ${String(differences.length)} difference(s)`,
          );
        } else {
          writeRecording(root, recording);
          console.info(
            `  wrote ${String(recording.files.size)} files (${fingerprint(recording)})`,
          );
        }
      }
    }
    // The nightly workflow tells "the comparison found a difference" from "the run failed" by this
    // file: it exists only when the comparison ran to the end.
    const report = process.env.GOLDEN_DRIFT_REPORT;
    if (args.check && problems.length > 0 && report !== undefined) {
      writeFileSync(report, `${problems.join('\n')}\n`);
    }
    expect(
      problems,
      `The golden fixtures differ from the brokers. Re-record with \`pnpm nx run adapter-mgmt-http:record-golden\` and review the diff.\n${problems.join('\n')}`,
    ).toEqual([]);
  },
  ONE_HOUR,
);
