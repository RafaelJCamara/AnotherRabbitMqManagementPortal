// The cell audit behind `nx run semantics:audit-cells`: structural rules every cell must satisfy,
// and optional requirements the caller can add (`--require=citations,effect`). It only reads cells;
// it cannot change a status or an evidence list, and it never opens a file itself, so it stays pure
// (the runner in tools/semantics-audit passes in a file-existence check).
//
// Always checked:
//  - ids are unique, and so are keys;
//  - every cell names at least one conformance id (the lab cell that will record its evidence);
//  - a cell that is not `code-derived` has evidence, and every evidence path belongs to one of the
//    cell's own conformance ids (`testing/lab-evidence/<version>/<CF-id>.json`);
//  - when the runner can tell, every evidence path exists.
import { cellKeyString, type SemanticsCell } from './schema.ts';

export const REQUIREMENTS = ['citations', 'conformance', 'effect'] as const;
export type Requirement = (typeof REQUIREMENTS)[number];

export interface AuditFinding {
  readonly cell: string;
  readonly rule: string;
  readonly message: string;
}

export interface AuditOptions {
  /** Extra requirements. `conformance` is always on; naming it is accepted and changes nothing. */
  readonly require?: readonly Requirement[];
  /** Whether an evidence path exists on disk; when absent, existence is not checked. */
  readonly evidenceExists?: (path: string) => boolean;
}

const EVIDENCE_CF = /\/(CF-[A-Z0-9-]+)\.json$/;

export function auditCells(
  cells: readonly SemanticsCell[],
  options: AuditOptions = {},
): AuditFinding[] {
  const required = new Set<Requirement>(options.require ?? []);
  const findings: AuditFinding[] = [];
  const report = (cell: SemanticsCell, rule: string, message: string): void => {
    findings.push({ cell: cell.id, rule, message });
  };

  const ids = new Map<string, number>();
  const keys = new Map<string, string>();
  for (const cell of cells) {
    ids.set(cell.id, (ids.get(cell.id) ?? 0) + 1);
    const key = cellKeyString(cell.key);
    const first = keys.get(key);
    if (first === undefined) keys.set(key, cell.id);
    else report(cell, 'duplicate-key', `has the same key as ${first} (${key})`);

    if (cell.conformance.length === 0) {
      report(cell, 'conformance', 'names no conformance id');
    }
    if (required.has('citations') && cell.citations.length === 0) {
      report(cell, 'citations', 'has no citation');
    }
    if (required.has('effect') && cell.effect === null) {
      report(cell, 'effect', 'has no derived effect yet');
    }
    if (cell.status !== 'code-derived' && cell.evidence.length === 0) {
      report(cell, 'status-evidence', `is ${cell.status} without lab evidence`);
    }
    for (const path of cell.evidence) {
      const cf = EVIDENCE_CF.exec(path)?.[1];
      if (cf === undefined || !cell.conformance.some((id) => id === cf)) {
        report(
          cell,
          'evidence-conformance',
          `evidence ${path} is not for one of its conformance ids`,
        );
      } else if (
        options.evidenceExists !== undefined &&
        !options.evidenceExists(path)
      ) {
        report(cell, 'evidence-missing', `evidence ${path} does not exist`);
      }
    }
  }
  for (const [id, count] of ids) {
    if (count > 1) {
      findings.push({
        cell: id,
        rule: 'duplicate-id',
        message: `the id is used by ${String(count)} cells`,
      });
    }
  }
  return findings;
}
