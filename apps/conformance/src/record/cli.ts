// `conformance:record` for one running lab broker, started by `libs/testkit/src/it/run-record.ts`
// (the launcher hands the broker over in LAB_BROKER, see driver/lab-endpoint.ts):
//
//   node apps/conformance/src/record/cli.ts --cells=CF-SMOKE-01[,CF-SETTLE-*] [--out=<folder>]
//
// In the `conformance-record` workflow (provenance `ci`) the artefacts go to testing/lab-evidence/;
// anywhere else they go to a fresh temporary folder, or to `--out`, and are marked `local`. A
// `local` artefact is refused by the writer if the folder is the evidence tree. Node strips the
// types, so no build step is needed (erasable syntax only).
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseLabBrokerData,
  verifyLabEndpoint,
  type LabEndpoint,
  type VerifyDeps,
} from '../driver/lab-endpoint.ts';
import { selectScenarios } from '../scenarios/index.ts';
import { provenanceFromEnv } from './provenance.ts';
import type { EvidenceProvenance } from './evidence.ts';
import { recordCells, type RecordHost } from './record.ts';

export const CANONICAL_ROOT = fileURLToPath(
  new URL('../../../../testing/lab-evidence', import.meta.url),
);

export interface CliArgs {
  readonly cells: string[];
  readonly out: string | undefined;
}

/** Reads `--cells=a,b` and `--out=folder`; anything else is an error, so a typo cannot pass silently. */
export function parseArgs(argv: readonly string[]): CliArgs {
  let cells: string[] | undefined;
  let out: string | undefined;
  for (const argument of argv) {
    const match = /^--(cells|out)=(.+)$/.exec(argument);
    if (!match?.[1] || match[2] === undefined) {
      throw new Error(
        `Unknown argument "${argument}". Options: --cells=CF-SMOKE-01[,CF-X-*] --out=<folder>`,
      );
    }
    if (match[1] === 'cells')
      cells = match[2].split(',').filter((id) => id !== '');
    else out = match[2];
  }
  if (cells === undefined || cells.length === 0) {
    throw new Error('--cells=<CF-id[,CF-id]> is required');
  }
  return { cells, out };
}

/** Where the artefacts go: --out, else the evidence tree for a ci run, else a fresh temporary folder. */
export function chooseRoot(
  out: string | undefined,
  provenance: EvidenceProvenance,
): string {
  return resolve(
    out ??
      (provenance.kind === 'ci'
        ? CANONICAL_ROOT
        : join(
            tmpdir(),
            `lab-evidence-local-${randomBytes(4).toString('hex')}`,
          )),
  );
}

/** What a test replaces: the Docker the endpoint is checked with and the broker connection. */
export interface MainDeps extends VerifyDeps {
  readonly openHost?: (endpoint: LabEndpoint) => Promise<RecordHost>;
}

export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  deps: MainDeps = {},
): Promise<number> {
  const args = parseArgs(argv);
  const scenarios = selectScenarios(args.cells);
  const endpoint = await verifyLabEndpoint(
    parseLabBrokerData(env.LAB_BROKER),
    deps,
  );
  const provenance = provenanceFromEnv(env);
  const root = chooseRoot(args.out, provenance);
  const files = await recordCells({
    scenarios,
    endpoint,
    provenance,
    root,
    canonicalRoot: CANONICAL_ROOT,
    runId: randomBytes(4).toString('hex'),
    ...(deps.openHost === undefined ? {} : { openHost: deps.openHost }),
  });
  for (const file of files) console.log(`recorded ${file}`);
  if (provenance.kind === 'local') {
    console.log(
      'This was a local run: the files are not lab evidence (only the conformance-record workflow records that, A-20).',
    );
  }
  return 0;
}

// Run only as a script, not when a spec imports parseArgs.
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
