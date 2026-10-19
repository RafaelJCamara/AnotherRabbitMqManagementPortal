// The machine-readable record of a `conformance:test` run: one JSON line per CellResult, appended to
// the file the launcher names in CONFORMANCE_REPORT. A skipped (unverified) test shows nothing in the
// test runner's own output, so the launcher reads this file and prints what could not be established.
import { appendFileSync } from 'node:fs';
import type { CellResult } from './three-way.ts';

export function appendReport(
  path: string | undefined,
  results: readonly CellResult[],
): void {
  if (path === undefined || path === '' || results.length === 0) return;
  appendFileSync(
    path,
    `${results.map((result) => JSON.stringify(result)).join('\n')}\n`,
  );
}
