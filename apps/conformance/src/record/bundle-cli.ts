// The command line of the `conformance-record` workflow's own checks (M0-71). Node runs it from the
// checkout; apart from `--integrity` it needs no `node_modules`.
//
//   node apps/conformance/src/record/bundle-cli.ts validate-inputs
//       CELLS and VERSIONS from the environment must be what `parseRecordInputs` accepts.
//   node apps/conformance/src/record/bundle-cli.ts check --dir=<bundle> [--integrity] [--pr-body=<file>]
//       The bundle folder must be what this run (the GITHUB_* variables, CELLS, VERSIONS and
//       DEFAULT_BRANCH) would have recorded. `--integrity` also verifies every artefact's schema and
//       SHA-256 (needs the install); `--pr-body` writes the description of the bot pull request.
//
// Exit 0 when everything holds, 1 with the reasons on stderr otherwise. It writes only the file named
// by `--pr-body`, and only after the bundle passed; it never touches `testing/lab-evidence`.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BundleError,
  checkBundle,
  expectationFromEnv,
  parseRecordInputs,
  renderPrBody,
  type CheckOptions,
} from './bundle.ts';

const PINS_FILE = fileURLToPath(
  new URL('../../../../testing/broker-lab/versions.json', import.meta.url),
);

type Env = Readonly<Record<string, string | undefined>>;

export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** `{ "<version>": "sha256:..." }` from testing/broker-lab/versions.json. */
export function readPins(path: string): Record<string, string> {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    brokers?: { version?: unknown; digest?: unknown }[];
  };
  const pins: Record<string, string> = {};
  for (const broker of parsed.brokers ?? []) {
    if (
      typeof broker.version === 'string' &&
      typeof broker.digest === 'string'
    ) {
      pins[broker.version] = broker.digest;
    }
  }
  return pins;
}

function option(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return argv
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

export async function main(
  argv: readonly string[],
  env: Env = process.env,
  io: CliIo = { out: console.log, err: console.error },
  pinsFile: string = PINS_FILE,
): Promise<number> {
  const [command, ...rest] = argv;
  try {
    const inputs = parseRecordInputs(env.CELLS, env.VERSIONS);
    if (command === 'validate-inputs') {
      if (rest.length > 0)
        throw new BundleError('validate-inputs takes no option');
      io.out(
        `cells: ${inputs.cells.join(', ')}; versions: ${inputs.versions.join(', ')}`,
      );
      return 0;
    }
    if (command !== 'check') {
      throw new BundleError(
        'usage: bundle-cli.ts validate-inputs | check --dir=<bundle> [--integrity] [--pr-body=<file>]',
      );
    }
    for (const argument of rest) {
      if (!/^--(dir|pr-body)=.+$|^--integrity$/.test(argument)) {
        throw new BundleError(`unknown option ${argument}`);
      }
    }
    const dir = option(rest, 'dir');
    if (dir === undefined) throw new BundleError('--dir=<bundle> is required');
    const expected = expectationFromEnv(env, inputs, readPins(pinsFile));
    const options: CheckOptions = rest.includes('--integrity')
      ? { verifyText: (await import('./evidence.ts')).verifyEvidenceText }
      : {};
    const report = checkBundle(resolve(dir), expected, options);
    if (report.problems.length > 0) {
      for (const problem of report.problems) io.err(`refused: ${problem}`);
      return 1;
    }
    const body = option(rest, 'pr-body');
    if (body !== undefined)
      writeFileSync(resolve(body), renderPrBody(expected, report.files));
    io.out(
      `${String(report.files.length)} artefacts match run ${expected.runUrl}`,
    );
    return 0;
  } catch (error) {
    io.err(
      `refused: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

// Run only as a script, not when a spec imports main.
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
