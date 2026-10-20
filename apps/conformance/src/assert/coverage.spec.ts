// The coverage gate over fake registries and fake evidence in temporary folders.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registryData, type SemanticsCell } from '@app/semantics';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { cfSmoke01 } from '../scenarios/cf-smoke-01.ts';
import { SCENARIOS } from '../scenarios/index.ts';
import { sealArtefact, type EvidenceProvenance } from '../record/evidence.ts';
import { runScenario, type LabScenario } from '../dsl.ts';
import { DIGEST, MemoryHost, VERSION } from '../testing/lab.ts';
import {
  artefactFile,
  OPS_DIGEST,
  OPS_CI,
  refusalFact,
  refusedGet,
} from '../testing/ops-artefacts.ts';
import { coverageGate, type CoverageInput } from './coverage.ts';
import { main } from './coverage-cli.ts';
import { labVersions, type LabVersion } from './lab-versions.ts';
import { OPS_CF_IDS } from './ops-facts.ts';
import { PROJECTIONS, projectSmoke01 } from './projections.ts';

const CI: EvidenceProvenance = {
  kind: 'ci',
  recorder: 'conformance:record',
  gitSha: 'a'.repeat(40),
  runUrl: 'https://github.com/acme/portal/actions/runs/1/attempts/1',
  workflow:
    'acme/portal/.github/workflows/conformance-record.yml@refs/heads/main',
  recordedAt: '2026-10-19T10:00:00.000Z',
};
const LABS: LabVersion[] = [
  { version: VERSION, digest: DIGEST, era: '4.3' },
  { version: '4.2.9', digest: DIGEST, era: '4.0-4.2' },
];
const cell = (change: Partial<SemanticsCell> = {}): SemanticsCell => ({
  id: 'SEM-4.3-classic-amqp091-nack',
  key: {
    era: '4.3',
    queueType: 'classic',
    protocol: 'amqp091',
    action: 'amqp091.nack_requeue',
  },
  effect: {
    deltaAC: 1,
    deltaDC: 0,
    countsTowardLimit: 'no',
    position: 'head',
    destructive: false,
  },
  citations: [],
  conformance: ['CF-SMOKE-01'],
  status: 'code-derived',
  evidence: [],
  ...change,
});

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function tree(versions: string[] = [VERSION]): Promise<string> {
  const run = await runScenario(new MemoryHost(), cfSmoke01, 'cov');
  const root = mkdtempSync(join(tmpdir(), 'conformance-coverage-'));
  roots.push(root);
  for (const version of versions) {
    mkdirSync(join(root, version), { recursive: true });
    const artefact = sealArtefact({
      schemaVersion: 1,
      cfId: 'CF-SMOKE-01',
      title: cfSmoke01.title,
      protocol: 'amqp091',
      brokerVersion: version,
      imageDigest: DIGEST,
      steps: run.steps,
      observations: run.observations,
      provenance: CI,
    });
    writeFileSync(
      join(root, version, 'CF-SMOKE-01.json'),
      JSON.stringify(artefact),
    );
  }
  return root;
}

const input = (change: Partial<CoverageInput> = {}): CoverageInput => ({
  cells: [cell()],
  versions: LABS,
  scenarios: [cfSmoke01],
  projections: { 'CF-SMOKE-01': projectSmoke01 },
  evidenceRoot: join(tmpdir(), 'conformance-coverage-none'),
  hasStub: () => true,
  strict: false,
  ...change,
});

describe('coverage gate', () => {
  it('AC-1 passes a registry that claims nothing the lab has not shown (code-derived cells, no evidence yet)', () => {
    const coverage = coverageGate(input());

    expect(coverage.failures).toEqual([]);
    expect(coverage.totals).toMatchObject({
      cells: 1,
      results: 1,
      confirmed: 0,
      unverified: 1,
      failed: 0,
    });
  });

  it('AC-1 fails a cell whose conformance id has no lab-cell spec', () => {
    const coverage = coverageGate(input({ hasStub: () => false }));

    expect(coverage.failures).toEqual([
      'SEM-4.3-classic-amqp091-nack: CF-SMOKE-01 has no lab-cell spec',
    ]);
  });

  it('AC-1 fails a lab-verified cell without recorded evidence, or one whose era has no lab version', () => {
    const noEvidence = coverageGate(
      input({ cells: [cell({ status: 'lab-verified' })] }),
    );
    const noVersion = coverageGate(
      input({
        cells: [
          cell({ status: 'lab-verified', key: { ...cell().key, era: '4.4' } }),
        ],
      }),
    );

    expect(noEvidence.failures.join('\n')).toContain(
      'is lab-verified but only 0 of 1 recorded results confirm it',
    );
    expect(noVersion.failures).toEqual([
      'SEM-4.3-classic-amqp091-nack: is lab-verified but no lab version has era 4.4',
    ]);
  });

  it('AC-1 fails a cell the recorded evidence contradicts, whatever its status', async () => {
    const root = await tree();

    const coverage = coverageGate(
      input({
        evidenceRoot: root,
        cells: [
          cell({
            effect: {
              deltaAC: 1,
              deltaDC: 0,
              countsTowardLimit: 'no',
              position: 'tail',
              destructive: false,
            },
          }),
        ],
      }),
    );

    expect(coverage.totals.failed).toBe(1);
    expect(coverage.failures.join('\n')).toContain(
      'the registry cell differs from the recorded evidence',
    );
  });

  it('confirms a cell with agreeing evidence on every lab version of its era, and passes a lab-verified one then', async () => {
    const root = await tree();

    const coverage = coverageGate(
      input({ evidenceRoot: root, cells: [cell({ status: 'lab-verified' })] }),
    );

    expect(coverage.failures).toEqual([]);
    expect(coverage.totals.confirmed).toBe(1);
  });

  it('AC-1 a lab-verified cell needs evidence on every lab version of its era, not on one of them', async () => {
    const root = await tree();
    const wide = cell({
      status: 'lab-verified',
      key: { ...cell().key, era: '4.0-4.2' },
    });

    const coverage = coverageGate(
      input({
        evidenceRoot: root,
        versions: [
          ...LABS,
          { version: '4.1.8', digest: DIGEST, era: '4.0-4.2' },
        ],
        cells: [wide],
      }),
    );

    expect(coverage.failures.join('\n')).toContain(
      'only 0 of 2 recorded results confirm it',
    );
  });

  it('strict: every cell, whatever its status, needs confirming evidence, and every id a scenario', async () => {
    const lenient = coverageGate(input());
    const strict = coverageGate(input({ strict: true, scenarios: [] }));
    const root = await tree();
    const confirmed = coverageGate(input({ strict: true, evidenceRoot: root }));

    expect(lenient.failures).toEqual([]);
    expect(strict.failures).toEqual([
      'SEM-4.3-classic-amqp091-nack: only 0 of 1 recorded results confirm it',
      'CF-SMOKE-01: no scenario can record it',
    ]);
    expect(confirmed.failures).toEqual([]);
  });

  it('AC-14 the deferred DOWN ids are flagged as having no scenario', () => {
    const deferred = ['02', '03', '04', '05', '06'].map((n) => `CF-DOWN-${n}`);
    const real = (strict: boolean) =>
      coverageGate({
        cells: registryData.cells,
        versions: labVersions(),
        scenarios: SCENARIOS,
        projections: PROJECTIONS,
        evidenceRoot: join(tmpdir(), 'conformance-coverage-none'),
        hasStub: () => true,
        strict,
      });

    const strict = real(true);
    for (const id of deferred) {
      expect(strict.failures).toContain(`${id}: no scenario can record it`);
      // Still a todo stub that names the follow-up slice, and no result for it is a pass.
      const stub = readFileSync(
        join(
          import.meta.dirname,
          '../cells',
          `${id.toLowerCase()}.cell.spec.ts`,
        ),
        'utf8',
      );
      expect(stub).toMatch(/it\.todo\('slice [CD]: /);
      const verdicts = strict.results.filter((r) => r.cfId === id);
      expect(verdicts.map((r) => r.verdict)).not.toContain('pass');
    }
    expect(strict.failures.join()).not.toContain('CF-DOWN-01: no scenario');
    // Without --strict they are counted and not a failure; the cells that name them are untouched.
    expect(real(false).failures).toEqual([]);
    expect(real(false).totals.withoutScenario).toBeGreaterThanOrEqual(5);
    for (const named of registryData.cells.filter((c) =>
      c.conformance.some((id) => deferred.includes(id)),
    )) {
      expect([named.status, named.evidence]).toEqual(['code-derived', []]);
    }
  });
  it('strict also fails a cell whose era has no lab version', () => {
    const coverage = coverageGate(
      input({
        strict: true,
        cells: [cell({ key: { ...cell().key, era: '4.4' } })],
      }),
    );

    expect(coverage.failures).toContain(
      'SEM-4.3-classic-amqp091-nack: no lab version has era 4.4',
    );
  });
});

describe('coverage command', () => {
  const quiet = (): void => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  };
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('AC-1 passes on the registry and the evidence tree this repository has', () => {
    quiet();

    expect(main([])).toBe(0);
  });

  it('AC-1 the strict gate fails over a tree with no evidence, because no cell is confirmed', async () => {
    quiet();
    const empty = await tree([]);

    expect(main(['--strict', `--evidence-root=${empty}`])).toBe(1);
  });

  it('refuses an unknown argument', () => {
    quiet();

    expect(main(['--loose'])).toBe(2);
  });
});

describe('operational facts', () => {
  const ids = ['CF-OPS-SAC-01', 'CF-OPS-STREAM-01', 'CF-OPS-UPGRADE-01'];
  const labs: LabVersion[] = [
    { version: '4.3.6', digest: OPS_DIGEST, era: '4.3' },
    { version: '4.2.9', digest: OPS_DIGEST, era: '4.0-4.2' },
  ];
  const ops = (change: Partial<CoverageInput> = {}): CoverageInput =>
    input({
      cells: [],
      versions: labs,
      // CF-OPS-STREAM-01 has neither a scenario nor a fact; CF-OPS-UPGRADE-01 applies to 4.3.6 only.
      scenarios: [ids[0], ids[2]].map(
        (cfId) => ({ ...cfSmoke01, cfId }) as LabScenario,
      ),
      facts: [
        refusalFact('CF-OPS-SAC-01'),
        refusalFact('CF-OPS-UPGRADE-01', { appliesTo: ['4.3.6'] }),
      ],
      opsIds: ids,
      ...change,
    });
  const tree = (entries: [string, string, number][]): string => {
    const root = mkdtempSync(join(tmpdir(), 'conformance-ops-'));
    roots.push(root);
    for (const [version, cfId, code] of entries) {
      mkdirSync(join(root, version), { recursive: true });
      const file = artefactFile(cfId, refusedGet(code), OPS_CI, version);
      if (file.kind === 'present')
        writeFileSync(join(root, file.path), file.text);
    }
    return root;
  };
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const NO_FACT = 'CF-OPS-STREAM-01: no fact judges it';
  const NO_SCENARIO = 'CF-OPS-STREAM-01: no scenario can record it';

  it('AC-7 the coverage gate counts the operational facts and fails a recorded contradiction', () => {
    const none = join(tmpdir(), 'conformance-ops-none');
    const lenient = coverageGate(ops({ evidenceRoot: none }));
    const strict = coverageGate(ops({ evidenceRoot: none, strict: true }));
    const bad = tree([
      ['4.2.9', 'CF-OPS-SAC-01', 405],
      ['4.3.6', 'CF-OPS-SAC-01', 406],
    ]);

    // Without evidence the facts are unverified and fail only the release gate; 4.2.9 is not asked
    // about CF-OPS-UPGRADE-01.
    expect(lenient.failures).toEqual([]);
    expect(lenient.totals).toMatchObject({ results: 3, unverified: 3 });
    expect(strict.failures.map((f) => f.split(': not confirmed')[0])).toEqual([
      NO_SCENARIO,
      NO_FACT,
      'ops:cf-ops-sac-01-refused on 4.3.6 (CF-OPS-SAC-01)',
      'ops:cf-ops-sac-01-refused on 4.2.9 (CF-OPS-SAC-01)',
      'ops:cf-ops-upgrade-01-refused on 4.3.6 (CF-OPS-UPGRADE-01)',
    ]);
    // A recorded contradiction fails with and without --strict.
    for (const strictRun of [false, true]) {
      const run = coverageGate(ops({ evidenceRoot: bad, strict: strictRun }));
      expect(run.totals.failed).toBe(1);
      expect(run.failures.join('\n')).toContain(
        'ops:cf-ops-sac-01-refused on 4.3.6 (CF-OPS-SAC-01): the recorded evidence contradicts the fact',
      );
    }
  });

  it('AC-7 agreeing evidence confirms a fact on every version it applies to; a fact that applies to no lab version fails strict', () => {
    const agree = tree([
      ['4.3.6', 'CF-OPS-SAC-01', 405],
      ['4.2.9', 'CF-OPS-SAC-01', 405],
      ['4.3.6', 'CF-OPS-UPGRADE-01', 405],
    ]);
    const confirmed = coverageGate(ops({ evidenceRoot: agree, strict: true }));
    const old = ops({
      versions: labs.slice(1),
      evidenceRoot: agree,
      strict: true,
    });

    expect(confirmed.totals.confirmed).toBe(3);
    expect(confirmed.failures).toEqual([NO_SCENARIO, NO_FACT]);
    expect(coverageGate(old).failures).toContain(
      'ops:cf-ops-upgrade-01-refused: applies to no lab version',
    );
  });

  it('AC-7 the command counts all eight operational ids', () => {
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(main(['--strict', `--evidence-root=${tree([])}`])).toBe(1);
    const shown = error.mock.calls.map((call) => String(call[0])).join('\n');
    for (const id of OPS_CF_IDS) {
      expect(shown).toContain(`${id}: no scenario can record it`);
      expect(shown).toContain(`${id}: no fact judges it`);
    }
  });
});
