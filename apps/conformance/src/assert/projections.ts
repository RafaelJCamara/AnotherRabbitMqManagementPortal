// What the recorded evidence of a conformance id says about a registry cell (the registry leg of the
// three-way assertion). A projection reads the artefact only: the observations the recorder wrote,
// never the registry's own words. The work package that writes a scenario writes its projection
// here, and a registry cell whose id has none can never be better than `unverified`.
import type { EvidenceArtefact } from '../record/evidence.ts';
import { projectCarry01, projectCarry03 } from './projections-carry.ts';
import { projectDown01 } from './projections-down.ts';
import { projectDr01, projectDr02 } from './projections-dr.ts';
import { projectSettle } from './projections-settle.ts';
import { projectStamp01 } from './projections-stamp.ts';
import type { Observed, Projection } from './three-way.ts';

/**
 * CF-SMOKE-01: a classic queue, `basic.get`, then `basic.nack` with requeue. Where did the first
 * message land: at the head of the drain, at its tail, or somewhere between (`original`), or was it
 * lost (`removed`)? A classic queue sends no counters, so only `position` and `destructive` are
 * projected.
 */
export const projectSmoke01: Projection = (
  evidence: EvidenceArtefact,
): Observed | null => {
  const survivors = evidence.observations.filter((item) => item.survived);
  const first = evidence.observations.find((item) => item.messageId === 'm1');
  if (first === undefined) return null;
  if (!first.survived || first.position === null) {
    return { position: 'removed', destructive: true };
  }
  if (first.position === 0) return { position: 'head', destructive: false };
  return {
    position: first.position === survivors.length - 1 ? 'tail' : 'original',
    destructive: false,
  };
};

export const PROJECTIONS: Readonly<Record<string, Projection>> = {
  'CF-SMOKE-01': projectSmoke01,
  'CF-STAMP-01': projectStamp01,
  'CF-CARRY-01': projectCarry01,
  'CF-CARRY-03': projectCarry03,
  'CF-DOWN-01': projectDown01,
  'CF-DR-01': projectDr01,
  'CF-DR-02': projectDr02,
  'CF-SETTLE-01': projectSettle('CF-SETTLE-01'),
  'CF-SETTLE-02': projectSettle('CF-SETTLE-02'),
  'CF-SETTLE-05': projectSettle('CF-SETTLE-05'),
};
