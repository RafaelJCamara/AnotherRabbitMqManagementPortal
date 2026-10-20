// The facts leg (M0-41, slice B): a fact that no registry cell names is judged from the recorded
// artefact, a live run and an expectation. Every artefact is hand-written (testing/ops-artefacts.ts).
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  artefactFile,
  liveRun,
  OPS_DIGEST,
  OPS_LOCAL,
  OPS_VERSION,
  refusalFact,
  refusedGet,
} from '../testing/ops-artefacts.ts';
import { evaluateFact, type FactInput } from './ops-facts.ts';
import { evaluateCase, settleCase } from './run-case.ts';
import { assertResult, formatResult, type CellResult } from './three-way.ts';

const CF = 'CF-OPS-SAC-01';

const judge = (change: Partial<FactInput> = {}): CellResult => {
  const [result, ...rest] = evaluateFact({
    fact: refusalFact(),
    version: OPS_VERSION,
    era: '4.3',
    pin: OPS_DIGEST,
    file: artefactFile(CF, refusedGet(405)),
    live: liveRun(CF, refusedGet(405)),
    ...change,
  });
  if (result === undefined || rest.length > 0) throw new Error('one result');
  return result;
};
const strictly = (result: CellResult) => () => {
  assertResult(result, { strict: true });
};

describe('facts leg', () => {
  it('AC-5 a fact whose evidence, live run and expectation agree passes', () => {
    expect(judge()).toMatchObject({
      verdict: 'pass',
      cellId: 'ops:cf-ops-sac-01-refused',
      cfId: CF,
      live: { state: 'match' },
      evidence: { state: 'valid' },
      registry: { state: 'match' },
      reasons: [],
    });
  });

  it('AC-6 a contradicting artefact fails, a missing one leaves the fact unverified, and nothing unproven is green', () => {
    const check = vi.fn(refusalFact().check);
    const fact = refusalFact(CF, { check });

    // (a) contradiction: a field-level diff of the fact, expected against observed.
    const contradicted = judge({
      file: artefactFile(CF, refusedGet(406)),
      live: liveRun(CF, refusedGet(406)),
    });
    expect(contradicted.verdict).toBe('fail');
    expect(contradicted.registry).toMatchObject({
      state: 'mismatch',
      diffs: [{ path: 'fact.code', expected: 405, actual: 406 }],
    });
    expect(formatResult(contradicted)).toContain(
      'fact.code: expected 405, observed 406',
    );
    expect(strictly(contradicted)).toThrow('fact.code');

    // (b) no artefact: unverified (fails only when strict), and the check is never asked.
    const missing = judge({
      fact,
      file: { kind: 'missing', path: `${OPS_VERSION}/${CF}.json` },
    });
    expect(missing.verdict).toBe('unverified');
    expect(missing.reasons).toEqual([
      'no evidence is recorded at testing/lab-evidence/4.3.6/CF-OPS-SAC-01.json',
    ]);
    expect(strictly(missing)).toThrow('unverified');
    expect(() => {
      assertResult(missing, { strict: false });
    }).not.toThrow();

    // (c) a local artefact that agrees with the expectation is still not evidence.
    const local = judge({
      fact,
      file: artefactFile(CF, refusedGet(405), OPS_LOCAL),
    });
    expect(local.verdict).toBe('fail');
    expect(local.reasons.join()).toContain('was not recorded by the CI');
    expect(check).not.toHaveBeenCalled();

    // (d) a check that has nothing to say is unverified, never a pass, even with a matching live run.
    const silent = judge({ file: artefactFile(CF, []), live: liveRun(CF, []) });
    expect(silent.verdict).toBe('unverified');
    expect(strictly(silent)).toThrow('does not speak of the fact');

    // (e) the live run must equal the record; without one the fact stays unverified.
    expect(judge({ live: liveRun(CF, refusedGet(406)) })).toMatchObject({
      verdict: 'fail',
      live: { state: 'mismatch' },
    });
    expect(judge({ live: null })).toMatchObject({
      verdict: 'unverified',
      registry: { state: 'match' },
    });
  });

  it('AC-5 an id with facts is judged by them on the versions they apply to, and a version none applies to is skipped', async () => {
    const evidenceRoot = join(tmpdir(), 'conformance-ops-none'); // no file there
    const lab = { version: OPS_VERSION, digest: OPS_DIGEST, era: '4.3' };
    const only436 = refusalFact(CF, { appliesTo: ['4.3.6'] });

    const judged = await evaluateCase(CF, lab, null, {
      evidenceRoot,
      facts: [only436, refusalFact(CF, { id: 'ops:x', appliesTo: ['4.2.9'] })],
    });
    const skipped = await evaluateCase(CF, { ...lab, version: '4.2.9' }, null, {
      evidenceRoot,
      facts: [only436],
    });

    expect(judged.map((r) => [r.cellId, r.verdict])).toEqual([
      ['ops:cf-ops-sac-01-refused', 'unverified'],
    ]);
    expect(skipped).toEqual([]);
    expect(settleCase(skipped, true, () => undefined)).toBe('unverified');
  });
});
