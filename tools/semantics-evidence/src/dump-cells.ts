// Prints the registry cells of one revision as JSON, for the check to read:
//   [SEMANTICS_EVIDENCE_REV=<commit>] node --import ./tools/semantics-evidence/register.mjs \
//     tools/semantics-evidence/src/dump-cells.ts [--data=<module exporting registryData>]
// With a revision, register.mjs serves the registry sources from that commit. With --versions=a,b\n// it also prints the semantics era the registry resolves for each broker version, so the check never\n// loads registry code into the process that holds the GitHub token. It only reads.
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseSemVer } from '@app/domain-model';
import {
  cellKeyString,
  semanticsRegistry,
  type SemanticsCell,
} from '@app/semantics';
import type { CellSnapshot } from './snapshot.ts';

const dataArg = process.argv
  .slice(2)
  .find((arg) => arg.startsWith('--data='))
  ?.slice('--data='.length);
const root = resolve(process.env.SEMANTICS_EVIDENCE_ROOT ?? process.cwd());

const module = (await import(
  dataArg === undefined
    ? '@app/semantics'
    : pathToFileURL(isAbsolute(dataArg) ? dataArg : join(root, dataArg)).href
)) as { registryData?: { cells?: readonly SemanticsCell[] } };
const cells = module.registryData?.cells;
if (cells === undefined) {
  console.error('the module does not export registryData with cells');
  process.exit(1);
}

const snapshot = (cell: SemanticsCell): CellSnapshot => ({
  id: cell.id,
  keyString: cellKeyString(cell.key),
  era: cell.key.era,
  effect: cell.effect === null ? null : { ...cell.effect },
  status: cell.status,
  conformance: [...cell.conformance],
  evidence: [...cell.evidence],
});
const versions =
  process.argv
    .slice(2)
    .find((arg) => arg.startsWith('--versions='))
    ?.slice('--versions='.length)
    .split(',')
    .filter((version) => version !== '') ?? [];
/** The era the registry resolves for a plain release, with positive evidence for 4.3 (I-3: the registry decides). */
const eraOf = (version: string): string | undefined => {
  const parsed = parseSemVer(version);
  return parsed === null
    ? undefined
    : semanticsRegistry.resolveEra({
        nodeVersions: [parsed],
        ff43Enabled: true,
        qqMachineVersions: [],
        build: 'oss',
        lastVerified: [],
      }).era;
};
const eras: Record<string, string> = {};
for (const version of versions) {
  const era = eraOf(version);
  if (era !== undefined) eras[version] = era;
}
process.stdout.write(JSON.stringify({ cells: cells.map(snapshot), eras }));
