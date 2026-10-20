// The lab cells of M0-40 are wired to the harness and make no claim of their own: the cells they name
// stay consistent, and a recorded artefact that contradicts a cell fails it.
// Slice A covers CF-STAMP-01, slice B CF-CARRY-01 and CF-CARRY-03, slice C CF-DR-01 and CF-DR-02;
// CF-CARRY-02 follows with slice D.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditCells, registryData } from '@app/semantics';
import { afterAll, describe, expect, it } from 'vitest';

import { evaluateCase } from '../assert/run-case.ts';
import { PROJECTIONS } from '../assert/projections.ts';
import type { LabVersion } from '../assert/lab-versions.ts';
import { runScenario, type LabScenario } from '../dsl.ts';
import {
  sealArtefact,
  type EvidenceObservation,
  type EvidenceStep,
} from '../record/evidence.ts';
import { SCENARIOS } from '../scenarios/index.ts';
import { EraBroker, ERA_VERSION } from '../testing/era-broker.ts';
import { DIGEST } from '../testing/lab.ts';

const WIRED = [
  'CF-STAMP-01',
  'CF-CARRY-01',
  'CF-CARRY-03',
  'CF-DR-01',
  'CF-DR-02',
];
const LAB: LabVersion = {
  version: ERA_VERSION['4.3'],
  digest: DIGEST,
  era: '4.3',
};

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const emptyRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'conformance-m040-'));
  roots.push(root);
  return root;
};

describe('the M0-40 lab cells', () => {
  // The harness wiring is checked here. "This change adds or flips nothing" is checked against the
  // base by `semantics-evidence:check --base` (I-14); a test cannot do it without git history, and a
  // pinned status or an empty-evidence list would turn red the day a maintainer merges the evidence
  // CI recorded. What stays true before and after that day is the cells' own consistency.
  it('AC-3 (M0-FIX-1) the wired lab cells are consistent: a status and its evidence agree, whenever the evidence arrives', () => {
    for (const id of WIRED) {
      const stub = readFileSync(
        join(import.meta.dirname, `${id.toLowerCase()}.cell.spec.ts`),
        'utf8',
      );
      expect(stub, id).toContain(`describeThreeWay('${id}')`);
      expect(
        SCENARIOS.map((scenario) => scenario.cfId),
        id,
      ).toContain(id);
      expect(PROJECTIONS[id], id).toBeTypeOf('function');
    }
    const named = registryData.cells.filter((cell) =>
      cell.conformance.some((id) => WIRED.includes(id)),
    );
    expect(named.length).toBeGreaterThan(0);
    expect(auditCells(named)).toEqual([]);

    // The same audit refuses what it exists to refuse (proof the check above can fail).
    const [template] = named;
    if (template === undefined) throw new Error('no cell names a wired id');
    const verifiedWithoutEvidence = {
      ...template,
      status: 'lab-verified' as const,
      evidence: [],
    };
    const evidenceOfAnotherCase = {
      ...template,
      status: 'lab-verified' as const,
      evidence: ['testing/lab-evidence/4.3.6/CF-SMOKE-01.json'],
    };
    expect(auditCells([verifiedWithoutEvidence]).map((f) => f.rule)).toEqual([
      'status-evidence',
    ]);
    expect(auditCells([evidenceOfAnotherCase]).map((f) => f.rule)).toEqual([
      'evidence-conformance',
    ]);
  });
  // A CI-stamped artefact (fabricated, in a temporary folder) that contradicts the 4.3 cell.
  const contradict = async (
    id: string,
    field: string,
    record: () => Promise<{
      steps: EvidenceStep[];
      observations: EvidenceObservation[];
    }>,
    eachCell = true,
  ): Promise<void> => {
    const run = await record();
    const artefact = sealArtefact({
      schemaVersion: 1,
      cfId: id,
      title: 'fabricated',
      protocol: 'amqp091',
      brokerVersion: LAB.version,
      imageDigest: DIGEST,
      steps: run.steps,
      observations: run.observations,
      provenance: {
        kind: 'ci',
        recorder: 'conformance:record',
        gitSha: 'a'.repeat(40),
        runUrl: 'https://github.com/acme/portal/actions/runs/1/attempts/1',
        workflow:
          'acme/portal/.github/workflows/conformance-record.yml@refs/heads/main',
        recordedAt: '2026-10-19T10:00:00.000Z',
      },
    });
    const root = emptyRoot();
    mkdirSync(join(root, LAB.version), { recursive: true });
    writeFileSync(
      join(root, LAB.version, `${id}.json`),
      JSON.stringify(artefact),
    );

    const contradicted = await evaluateCase(id, LAB, null, {
      evidenceRoot: root,
    });
    const failed = contradicted.filter((result) => result.verdict === 'fail');
    expect(failed.length).toBeGreaterThan(0);
    const paths = failed.map((result) =>
      result.registry.state === 'mismatch'
        ? result.registry.diffs.map((diff) => diff.path)
        : null,
    );
    // Every failure is a field-level mismatch; each one names the field, unless the artefact (an
    // era's, read with that era's headers) also contradicts cells that do not claim this field.
    expect(paths.every((list) => list !== null)).toBe(true);
    for (const list of eachCell ? paths : []) expect(list).toContain(field);
    expect(paths.some((list) => list?.includes(field))).toBe(true);
    expect(contradicted.some((result) => result.verdict === 'pass')).toBe(
      false,
    );

    const missing = await evaluateCase(id, LAB, null, {
      evidenceRoot: emptyRoot(),
    });
    expect(missing.length).toBeGreaterThan(0);
    for (const result of missing) {
      expect(result.verdict).toBe('unverified');
      expect(result.reasons.join(' ')).toContain('no evidence is recorded');
    }
  };

  it('AC-12 a contradicting artefact fails the cell and a missing one leaves it unverified', async () => {
    // A control message counted twice contradicts the CF-STAMP-01 cell (one acquisition); a message
    // that stays in the dead-letter queue after a return, although it arrived above the delivery
    // limit, contradicts the CF-CARRY-03 cell (`if-dc-gt-limit`).
    await contradict('CF-STAMP-01', 'effect.deltaAC', () =>
      runScenario(
        new EraBroker('4.3', { skewed: 'fin-control' }),
        scenarioOf('CF-STAMP-01'),
        'r1',
      ),
    );
    await contradict('CF-CARRY-03', 'effect.countsTowardLimit', async () => {
      const run = await runScenario(
        new EraBroker('4.3'),
        scenarioOf('CF-CARRY-03'),
        'r1',
      );
      const observations = run.observations.map((item) =>
        item.name === 'dlq-after-return'
          ? { ...item, survived: true, position: 0 }
          : item,
      );
      return { ...run, observations };
    });
    // The era without delayed retry gives every message back at once, which contradicts the 4.3
    // cells' delayed position (CF-DR-01 and CF-DR-02); its counter headers differ too (fact sheet b.1).
    for (const [id, field] of [
      ['CF-DR-01', 'effect.position'],
      ['CF-DR-02', 'effect.position'],
    ] as const) {
      await contradict(
        id,
        field,
        () => {
          const broker = new EraBroker('4.0-4.2');
          return runScenario(
            broker,
            scenarioOf(id),
            'r1',
            undefined,
            broker.clock,
          );
        },
        false,
      );
    }
  });
});

function scenarioOf(id: string): LabScenario {
  const scenario = SCENARIOS.find((item) => item.cfId === id);
  if (scenario === undefined) throw new Error(`${id} has no scenario`);
  return scenario;
}
