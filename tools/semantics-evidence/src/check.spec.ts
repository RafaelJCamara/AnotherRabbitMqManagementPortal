// The semantics-evidence check against fake evidence (never testing/lab-evidence): each test tries
// to get a change past the check that I-14 says must not pass.
import { describe, expect, it, vi } from 'vitest';
import { checkEvidence, type CheckInput, type Finding } from './check.ts';
import type { CiProvenance } from './evidence-format.ts';
import {
  cell,
  ciStamp,
  DIGEST,
  evidencePath,
  fakeEvidence,
  SHA,
  type Fake,
} from './testing.ts';

const ERAS: Record<string, string> = {
  '3.13.7': '3.13',
  '4.2.9': '4.0-4.2',
  '4.3.6': '4.3',
};

function input(
  options: {
    files?: readonly (Fake | readonly [string, string | null])[];
    base?: CheckInput['base'];
    head?: CheckInput['head'];
    changed?: readonly string[];
    verifyRun?: CheckInput['verifyRun'];
    verifyAllRuns?: boolean;
  } = {},
): CheckInput {
  const tree = new Map<string, string | null>(
    (options.files ?? []).map((file) =>
      'path' in file ? [file.path, file.text] : [file[0], file[1]],
    ),
  );
  return {
    base: options.base ?? [],
    head: options.head ?? [],
    tree,
    changed: new Set(options.changed ?? []),
    pins: new Map(Object.keys(ERAS).map((version) => [version, DIGEST])),
    eraOf: (version) => ERAS[version],
    verifyRun: options.verifyRun ?? (() => Promise.resolve(null)),
    ...(options.verifyAllRuns === undefined
      ? {}
      : { verifyAllRuns: options.verifyAllRuns }),
  };
}

const rules = (findings: readonly Finding[]): string[] =>
  findings.map((finding) => finding.rule).sort();

describe('semantics-evidence check: status and effect changes', () => {
  const good = fakeEvidence();

  it('AC-1 passes a cell that flips to lab-verified with a valid CI artefact for its own CF id and era', async () => {
    const findings = await checkEvidence(
      input({
        files: [good],
        base: [cell()],
        head: [
          cell({ status: 'lab-verified', evidence: [evidencePath(good)] }),
        ],
        changed: [good.path],
      }),
    );

    expect(findings).toEqual([]);
  });

  it('AC-1 fails a flip to lab-verified with no evidence listed', async () => {
    const findings = await checkEvidence(
      input({ base: [cell()], head: [cell({ status: 'lab-verified' })] }),
    );

    expect(rules(findings)).toEqual(['status-change', 'status-evidence']);
  });

  it('AC-1 fails a flip whose evidence file is not in the tree, and one that names a file outside the evidence tree', async () => {
    const missing = await checkEvidence(
      input({
        base: [cell()],
        head: [
          cell({ status: 'lab-verified', evidence: [evidencePath(good)] }),
        ],
      }),
    );
    const outside = await checkEvidence(
      input({
        files: [good],
        base: [cell()],
        head: [
          cell({ status: 'lab-verified', evidence: [`other/${good.path}`] }),
        ],
      }),
    );

    const bare = await checkEvidence(
      input({
        files: [good],
        base: [cell()],
        head: [cell({ status: 'lab-verified', evidence: [good.path] })],
      }),
    );

    expect(rules(bare)).toEqual(['cell-evidence', 'status-change']);
    expect(bare[0]?.message).toContain('is not below testing/lab-evidence/');
    expect(rules(missing)).toEqual(['cell-evidence', 'status-change']);
    expect(missing[0]?.message).toContain('does not exist');
    expect(rules(outside)).toEqual(['cell-evidence', 'status-change']);
  });

  it('AC-1 fails an effect change on a cell no artefact supports, whatever its status', async () => {
    const changed = cell({
      effect: { deltaAC: 0, deltaDC: 1, position: 'tail' },
    });

    const unverified = await checkEvidence(
      input({ base: [cell()], head: [changed] }),
    );
    const dropped = await checkEvidence(
      input({ base: [cell()], head: [cell({ effect: null })] }),
    );

    expect(rules(unverified)).toEqual(['effect-change']);
    expect(rules(dropped)).toEqual(['effect-change']);
  });

  it('AC-1 passes an effect change only when valid evidence for the cell exists', async () => {
    const findings = await checkEvidence(
      input({
        files: [good],
        base: [
          cell({ status: 'lab-contradicted', evidence: [evidencePath(good)] }),
        ],
        head: [
          cell({
            status: 'lab-verified',
            evidence: [evidencePath(good)],
            effect: { deltaAC: 0, deltaDC: 1, position: 'tail' },
          }),
        ],
      }),
    );

    expect(findings).toEqual([]);
  });

  it('OQ-451 turning a null effect of an unverified stub into a value is allowed, and nothing else may', async () => {
    const stub = cell({ effect: null });

    const derived = await checkEvidence(
      input({ base: [stub], head: [cell()] }),
    );
    const withStatus = await checkEvidence(
      input({ base: [stub], head: [cell({ status: 'lab-verified' })] }),
    );
    const rewritten = await checkEvidence(
      input({
        base: [cell()],
        head: [cell({ effect: { deltaAC: 1, deltaDC: 1, position: 'head' } })],
      }),
    );

    expect(derived).toEqual([]);
    expect(rules(withStatus)).toContain('status-change');
    expect(rules(rewritten)).toEqual(['effect-change']);
  });

  it('AC-1 counts a cell with the same key under another id as the same cell', async () => {
    const verified = cell({
      status: 'lab-verified',
      evidence: [evidencePath(good)],
    });

    const findings = await checkEvidence(
      input({
        files: [good],
        base: [verified],
        head: [
          cell({
            id: 'SEM-replacement',
            status: 'code-derived',
            effect: { deltaAC: 0, deltaDC: 0, position: 'tail' },
          }),
        ],
      }),
    );

    expect(rules(findings)).toEqual(['effect-change', 'status-change']);
  });

  it('AC-1 fails a lab status that was already there when its evidence is no longer valid', async () => {
    const bad = fakeEvidence({
      provenance: ciStamp({ kind: 'ci' }),
      body: { title: '' },
    });

    const findings = await checkEvidence(
      input({
        files: [bad],
        base: [cell({ status: 'lab-verified', evidence: [evidencePath(bad)] })],
        head: [cell({ status: 'lab-verified', evidence: [evidencePath(bad)] })],
      }),
    );

    expect(rules(findings)).toContain('cell-evidence');
    expect(rules(findings)).toContain('evidence-file');
  });

  it('AC-1 fails a cell that names no conformance id', async () => {
    const findings = await checkEvidence(
      input({ head: [cell({ conformance: [] })] }),
    );

    expect(rules(findings)).toEqual(['cell-conformance']);
  });

  it('AC-1 passes a new code-derived cell and an unchanged tree', async () => {
    const findings = await checkEvidence(
      input({ files: [good], base: [], head: [cell()] }),
    );

    expect(findings).toEqual([]);
  });
});

describe('semantics-evidence check: the artefacts', () => {
  const verified = (
    fake: Fake,
    change: Partial<ReturnType<typeof cell>> = {},
  ) =>
    cell({ status: 'lab-verified', evidence: [evidencePath(fake)], ...change });

  it('AC-1 fails an artefact with local provenance, listed by a cell or not', async () => {
    const local = fakeEvidence({
      provenance: {
        kind: 'local',
        recorder: 'conformance:record',
        gitSha: null,
        recordedAt: '2026-10-19T10:00:00.000Z',
      },
    });

    const listed = await checkEvidence(
      input({ files: [local], head: [verified(local)] }),
    );
    const stray = await checkEvidence(input({ files: [local] }));

    expect(rules(listed)).toEqual(['cell-evidence', 'evidence-local']);
    expect(rules(stray)).toEqual(['evidence-local']);
  });

  it('AC-1 fails a tampered artefact', async () => {
    const good = fakeEvidence();
    const tampered = {
      path: good.path,
      text: good.text.replace('"ok":true', '"ok":false'),
    };

    const findings = await checkEvidence(
      input({ files: [tampered], head: [verified(tampered)] }),
    );

    expect(rules(findings)).toEqual(['cell-evidence', 'evidence-file']);
    expect(findings.map((finding) => finding.message).join()).toContain(
      'integrity digest',
    );
  });

  it('AC-1 fails an artefact that is not valid JSON of the artefact shape, or has an extra field', async () => {
    const good = fakeEvidence();
    const extra = {
      path: '4.2.9/CF-SMOKE-03.json',
      text: JSON.stringify({ ...JSON.parse(good.text), note: 'hand written' }),
    };

    const findings = await checkEvidence(
      input({
        files: [
          ['4.3.6/CF-SMOKE-01.json', 'not json'],
          ['4.2.9/CF-SMOKE-02.json', '{}'],
          extra,
        ],
      }),
    );

    expect(rules(findings)).toEqual([
      'evidence-file',
      'evidence-file',
      'evidence-file',
    ]);
  });

  it('AC-1 fails an artefact filed under another version or another id', async () => {
    const good = fakeEvidence();

    const findings = await checkEvidence(
      input({
        files: [
          ['4.2.9/CF-SMOKE-01.json', good.text],
          ['4.3.6/CF-OTHER-01.json', good.text],
        ],
      }),
    );

    expect(rules(findings)).toEqual(['evidence-file', 'evidence-file']);
    expect(findings[0]?.message).toContain('holds the evidence of');
  });

  it('AC-1 fails an artefact for another CF id than the cell names, and one from another era', async () => {
    const other = fakeEvidence({ cfId: 'CF-OTHER-01' });
    const old = fakeEvidence({ version: '4.2.9' });

    const wrongCf = await checkEvidence(
      input({ files: [other], head: [verified(other)] }),
    );
    const wrongEra = await checkEvidence(
      input({ files: [old], head: [verified(old)] }),
    );

    expect(rules(wrongCf)).toEqual(['cell-evidence']);
    expect(wrongCf[0]?.message).toContain('CF-OTHER-01');
    expect(rules(wrongEra)).toEqual(['cell-evidence']);
    expect(wrongEra[0]?.message).toContain('era 4.0-4.2');
  });

  it('AC-1 fails one bad artefact among several, and an image other than the pinned one', async () => {
    const good = fakeEvidence();
    const second = fakeEvidence({
      version: '4.2.9',
      cfId: 'CF-SMOKE-01',
      digest: `sha256:${'c'.repeat(64)}`,
    });
    const unknown = fakeEvidence({ version: '9.9.9' });

    const findings = await checkEvidence(
      input({
        files: [good, second, unknown],
        head: [
          cell({
            status: 'lab-verified',
            evidence: [evidencePath(good), evidencePath(second)],
          }),
        ],
      }),
    );

    expect(rules(findings)).toEqual([
      'cell-evidence',
      'evidence-pin',
      'evidence-pin',
    ]);
  });

  it('AC-1 fails a link or an oversized file in the tree and a stray file, but allows schema.json and a README', async () => {
    const findings = await checkEvidence(
      input({
        files: [
          ['4.3.6/CF-LINK-01.json', null],
          ['notes.txt', 'hello'],
          ['4.3.6/deep/CF-X-01.json', '{}'],
          ['schema.json', '{}'],
          ['README.md', '# evidence'],
        ],
      }),
    );

    expect(rules(findings)).toEqual([
      'evidence-file',
      'evidence-file',
      'evidence-file',
    ]);
  });
});

describe('semantics-evidence check: the run behind a CI stamp (I-14)', () => {
  const good = fakeEvidence();
  const flipped = (): Pick<CheckInput, 'base' | 'head'> => ({
    base: [cell()],
    head: [cell({ status: 'lab-verified', evidence: [evidencePath(good)] })],
  });

  it('AC-1 fails when the run is not a good one, and says why', async () => {
    const verifyRun = vi.fn(() => Promise.resolve('the run is in_progress'));

    const findings = await checkEvidence(
      input({ files: [good], ...flipped(), changed: [good.path], verifyRun }),
    );

    expect(findings).toEqual([
      {
        rule: 'evidence-run',
        subject: evidencePath(good),
        message: 'the run is in_progress',
      },
    ]);
    expect(verifyRun).toHaveBeenCalledTimes(1);
  });

  it('AC-1 fails closed when the verifier throws', async () => {
    const findings = await checkEvidence(
      input({
        files: [good],
        changed: [good.path],
        verifyRun: () => Promise.reject(new Error('network down')),
      }),
    );

    expect(rules(findings)).toEqual(['evidence-run']);
    expect(findings[0]?.message).toContain('network down');
  });

  it('checks the run of an artefact the change touches, of the evidence of a changed cell, and of everything on demand, once per run', async () => {
    const touched = vi.fn(() => Promise.resolve(null));
    const viaCell = vi.fn(() => Promise.resolve(null));
    const all = vi.fn(() => Promise.resolve(null));
    const second = fakeEvidence({ cfId: 'CF-SMOKE-02' });

    await checkEvidence(
      input({ files: [good], changed: [good.path], verifyRun: touched }),
    );
    await checkEvidence(
      input({ files: [good], ...flipped(), verifyRun: viaCell }),
    );
    await checkEvidence(
      input({ files: [good, second], verifyAllRuns: true, verifyRun: all }),
    );

    expect(touched).toHaveBeenCalledTimes(1);
    expect(viaCell).toHaveBeenCalledTimes(1);
    expect(all).toHaveBeenCalledTimes(1);
  });

  it('does not ask about artefacts nothing touches', async () => {
    const verifyRun = vi.fn(() => Promise.resolve('never'));

    const findings = await checkEvidence(
      input({
        files: [good],
        base: [
          cell({ status: 'lab-verified', evidence: [evidencePath(good)] }),
        ],
        head: [
          cell({ status: 'lab-verified', evidence: [evidencePath(good)] }),
        ],
        verifyRun,
      }),
    );

    expect(findings).toEqual([]);
    expect(verifyRun).not.toHaveBeenCalled();
  });

  it('passes the stamp of the artefact to the verifier', async () => {
    const seen: CiProvenance[] = [];

    await checkEvidence(
      input({
        files: [good],
        changed: [good.path],
        verifyRun: (stamp) => {
          seen.push(stamp);
          return Promise.resolve(null);
        },
      }),
    );

    expect(seen.map((stamp) => stamp.gitSha)).toEqual([SHA]);
  });
});
