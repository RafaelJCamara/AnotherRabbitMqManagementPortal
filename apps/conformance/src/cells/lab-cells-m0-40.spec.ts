// The lab cells of M0-40 are wired to the harness and make no claim of their own: no registry cell
// changes, no evidence file is created, and a recorded artefact that contradicts a cell fails it.
// Slice A covers CF-STAMP-01; the other five ids follow with their slices.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registryData } from '@app/semantics';
import { afterAll, describe, expect, it } from 'vitest';

import { evaluateCase } from '../assert/run-case.ts';
import { PROJECTIONS } from '../assert/projections.ts';
import type { LabVersion } from '../assert/lab-versions.ts';
import { runScenario } from '../dsl.ts';
import { sealArtefact } from '../record/evidence.ts';
import { SCENARIOS } from '../scenarios/index.ts';
import { EraBroker, ERA_VERSION } from '../testing/era-broker.ts';
import { DIGEST } from '../testing/lab.ts';

const IDS_IN_SLICE_A = ['CF-STAMP-01'];
const REPO = join(import.meta.dirname, '..', '..', '..', '..');
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
  it('AC-11 the six lab cells are wired to the harness and no registry cell or evidence file changed', () => {
    for (const id of IDS_IN_SLICE_A) {
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
    // No cell naming these ids was touched: still code-derived, with no evidence listed.
    const named = registryData.cells.filter((cell) =>
      cell.conformance.some((id) => IDS_IN_SLICE_A.includes(id)),
    );
    expect(named.length).toBeGreaterThan(0);
    for (const cell of named) {
      expect([cell.status, cell.evidence], cell.id).toEqual([
        'code-derived',
        [],
      ]);
    }
    expect(existsSync(join(REPO, 'testing', 'lab-evidence'))).toBe(false);
  });

  it('AC-12 a contradicting artefact fails the cell and a missing one leaves it unverified', async () => {
    // A CI-stamped artefact (fabricated, in a temporary folder) whose control message was counted
    // twice: it contradicts the 4.3 cell, which says one acquisition.
    const run = await runScenario(
      new EraBroker('4.3', { skewed: 'fin-control' }),
      SCENARIOS.find((scenario) => scenario.cfId === 'CF-STAMP-01') ?? fail(),
      'r1',
    );
    const artefact = sealArtefact({
      schemaVersion: 1,
      cfId: 'CF-STAMP-01',
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
      join(root, LAB.version, 'CF-STAMP-01.json'),
      JSON.stringify(artefact),
    );

    const contradicted = await evaluateCase('CF-STAMP-01', LAB, null, {
      evidenceRoot: root,
    });
    const failed = contradicted.filter((result) => result.verdict === 'fail');
    expect(failed.length).toBeGreaterThan(0);
    for (const result of failed) {
      expect(result.registry.state).toBe('mismatch');
      if (result.registry.state === 'mismatch') {
        expect(result.registry.diffs.map((diff) => diff.path)).toContain(
          'effect.deltaAC',
        );
      }
    }
    expect(contradicted.some((result) => result.verdict === 'pass')).toBe(
      false,
    );

    const missing = await evaluateCase('CF-STAMP-01', LAB, null, {
      evidenceRoot: emptyRoot(),
    });
    expect(missing.length).toBeGreaterThan(0);
    for (const result of missing) {
      expect(result.verdict).toBe('unverified');
      expect(result.reasons.join(' ')).toContain('no evidence is recorded');
    }
  });
});

function fail(): never {
  throw new Error('CF-STAMP-01 has no scenario');
}
