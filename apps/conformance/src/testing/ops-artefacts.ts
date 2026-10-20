// Hand-written evidence for the facts leg's specs (M0-41, slice B): no scenario and no host produced
// these steps, so a check that agrees with them proves something about the check (OQ-510, OQ-522).
import type { OpsFact } from '../assert/ops-facts.ts';
import type { EvidenceFile } from '../assert/three-way.ts';
import {
  sealArtefact,
  type EvidenceProvenance,
  type EvidenceStep,
} from '../record/evidence.ts';

export const OPS_VERSION = '4.3.6';
export const OPS_DIGEST = `sha256:${'b'.repeat(64)}`;
const RECORDED = {
  recorder: 'conformance:record',
  recordedAt: '2026-10-19T10:00:00.000Z',
} as const;
export const OPS_CI: EvidenceProvenance = {
  ...RECORDED,
  kind: 'ci',
  gitSha: 'a'.repeat(40),
  runUrl: 'https://github.com/acme/portal/actions/runs/1/attempts/1',
  workflow:
    'acme/portal/.github/workflows/conformance-record.yml@refs/heads/main',
};
export const OPS_LOCAL: EvidenceProvenance = {
  ...RECORDED,
  kind: 'local',
  gitSha: null,
};

export const refusedGet = (code: number): EvidenceStep[] => [
  {
    index: 0,
    op: 'tryGet',
    args: { as: 'reader', queue: 'q' },
    result: {
      outcome: 'refused',
      level: 'channel',
      code,
      reply: 'RESOURCE_LOCKED',
    },
  },
];

export const liveRun = (
  cfId: string,
  steps: EvidenceStep[],
  version = OPS_VERSION,
) => ({
  cfId,
  title: 'hand-written',
  protocol: 'amqp091' as const,
  brokerVersion: version,
  imageDigest: OPS_DIGEST,
  steps,
  observations: [],
});

export const artefactFile = (
  cfId: string,
  steps: EvidenceStep[],
  provenance: EvidenceProvenance = OPS_CI,
  version = OPS_VERSION,
): EvidenceFile => ({
  kind: 'present',
  path: `${version}/${cfId}.json`,
  text: JSON.stringify(
    sealArtefact({
      schemaVersion: 1 as const,
      ...liveRun(cfId, steps, version),
      provenance,
    }),
  ),
});
/** A fact on `cfId`: the first `tryGet` must be a channel-level refusal with code 405 (fact sheet b.7). */
export const refusalFact = (
  cfId = 'CF-OPS-SAC-01',
  overrides: Partial<OpsFact> = {},
): OpsFact => ({
  id: `ops:${cfId.toLowerCase()}-refused`,
  cfId,
  appliesTo: 'all-lab-versions',
  source: 'fact sheet b.7',
  check: (evidence) => {
    const step = evidence.steps.find((item) => item.op === 'tryGet');
    if (step === undefined) return null;
    const { outcome = null, level = null, code = null } = step.result;
    return {
      expected: { outcome: 'refused', level: 'channel', code: 405 },
      observed: { outcome, level, code },
    };
  },
  ...overrides,
});
