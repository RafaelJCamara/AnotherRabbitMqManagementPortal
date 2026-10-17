// Runs every supply-chain gate over a workspace view. Used by run-gates.ts (the real repository)
// and gates-selftest.ts (planted fixtures).
import { checkAllowlist } from './allowlist-gate.ts';
import {
  checkDevLicences,
  checkLicenceCoverage,
  checkShippedLicences,
} from './licence-gate.ts';
import { checkLockfile } from './lockfile-gate.ts';
import { checkPins } from './pin-gate.ts';
import { dedupe, tryParseLockfile } from './shared.ts';
import type { Licence, Violation, Workspace } from './shared.ts';

export interface GateInputs {
  /** Installed packages and their licences (`pnpm licenses list --json`, flattened). */
  licences: Licence[];
  /** Bundled packages of a release artefact; omitted until a build produces them. */
  shipped?: Licence[];
}

export function runAllGates(ws: Workspace, inputs: GateInputs): Violation[] {
  const lock = tryParseLockfile(ws);
  return dedupe([
    ...checkLockfile(ws),
    ...checkPins(ws),
    ...checkAllowlist(ws),
    ...checkDevLicences(inputs.licences),
    ...(lock === undefined
      ? []
      : checkLicenceCoverage(lock.packages, inputs.licences)),
    ...(inputs.shipped === undefined
      ? []
      : checkShippedLicences(inputs.shipped)),
  ]);
}

export function formatViolations(violations: Violation[]): string {
  return violations
    .map((v) => `  [${v.rule}] ${v.subject}\n      ${v.message}`)
    .join('\n');
}
