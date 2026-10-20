// CF-DOWN-01 projection over hand-written artefacts. The broker doubles encode what the registry
// claims, so they must not be used to confirm a projection (OQ-510): every artefact here is written
// out, queue by queue, with the counters a test wants the projection to read.
import { registryData, type SemanticsCell } from '@app/semantics';
import { describe, expect, it } from 'vitest';

import {
  sealArtefact,
  type EvidenceArtefact,
  type EvidenceObservation,
  type EvidenceStep,
} from '../record/evidence.ts';
import { DIGEST } from '../testing/lab.ts';
import { pathDivergence, projectDown01 } from './projections-down.ts';
import { evaluate } from './three-way.ts';

const PATHS = ['get', 'active', 'cancelled'];
const QUEUES = [
  ...['unset', 'fin', 'minus1'].flatMap((l) => PATHS.map((p) => `${l}-${p}`)),
  ...PATHS.map((p) => `fin-${p}-x`),
  'fin-conn',
];
const CI = {
  kind: 'ci',
  recorder: 'conformance:record',
  gitSha: 'a'.repeat(40),
  runUrl: 'https://github.com/acme/portal/actions/runs/1/attempts/1',
  workflow:
    'acme/portal/.github/workflows/conformance-record.yml@refs/heads/main',
  recordedAt: '2026-10-19T10:00:00.000Z',
} as const;

/** What the drain found of `m1`: its [x-delivery-count, x-acquired-count, position], or null when it was gone. */
type M1 = readonly [dc: number | null, ac: number | null, at: number] | null;
const crossed = (queue: string): boolean => queue.endsWith('-x');
/** The common case: single rounds keep `m1` (head, DC and AC 1), crossing rounds drop it. */
const dropsOnCrossing = (queue: string): M1 =>
  crossed(queue) ? null : [1, 1, 0];

const row = (
  queue: string,
  id: string,
  at: number | null,
  dc: number | null = null,
  ac: number | null = null,
): EvidenceObservation => ({
  name: `${queue}-after`,
  messageId: `${queue}-${id}`,
  survived: at !== null,
  position: at,
  redelivered: at === null ? null : true,
  'x-delivery-count': dc,
  'x-acquired-count': ac,
});

function artefact(
  m1: (queue: string) => M1,
  options: {
    holder?: (queue: string, round: number) => string;
    without?: string;
  } = {},
): EvidenceArtefact {
  const steps: EvidenceStep[] = [];
  const observations: EvidenceObservation[] = [];
  for (const queue of QUEUES.filter((q) => q !== options.without)) {
    const holds = crossed(queue)
      ? [1, 2, 3].map((n) => `${queue}-r${String(n)}`)
      : [`${queue}-held`];
    holds.forEach((as, n) =>
      steps.push({
        index: steps.length,
        op: 'get',
        args: { as, queue },
        result: {
          empty: false,
          messageId: options.holder?.(queue, n + 1) ?? `${queue}-m1`,
          'x-delivery-count': null,
          'x-acquired-count': null,
        },
      }),
    );
    const found = m1(queue);
    observations.push(
      found === null
        ? row(queue, 'm1', null)
        : row(queue, 'm1', found[2], found[0], found[1]),
      row(queue, 'm2', found?.[2] === 0 ? 1 : 0),
    );
  }
  return sealArtefact({
    schemaVersion: 1,
    cfId: 'CF-DOWN-01',
    title: 'hand-written',
    protocol: 'amqp091',
    brokerVersion: '4.3.6',
    imageDigest: DIGEST,
    steps,
    observations,
    provenance: CI,
  });
}

const cellOf = (era: string, limit: string): SemanticsCell => {
  const found = registryData.cells.find(
    (cell) =>
      cell.conformance.includes('CF-DOWN-01') &&
      cell.key.era === era &&
      cell.key.limit === limit,
  );
  if (found === undefined) throw new Error(`no ${era} ${limit} cell`);
  return found;
};

/** The three-way assertion of the 4.3.6 evidence file for these cells (no live leg). */
const assertion = (recorded: EvidenceArtefact, cells: SemanticsCell[]) =>
  evaluate({
    cfId: 'CF-DOWN-01',
    version: '4.3.6',
    era: '4.3',
    pin: DIGEST,
    cells,
    file: {
      kind: 'present',
      path: '4.3.6/CF-DOWN-01.json',
      text: JSON.stringify(recorded),
    },
    live: null,
    projection: projectDown01,
  })[0];

describe('CF-DOWN-01 projection', () => {
  it('AC-1 4.3.6 channel close while holding a QQ delivery: the recorded DC and AC deltas confirm the finite cell', () => {
    // As 4.3.6 is expected to record it: m1 back at the head with both counters at 1; on the
    // crossing queues it was dropped after the third return.
    const recorded = artefact(dropsOnCrossing);
    const cell = cellOf('4.3', 'finite');

    expect(projectDown01(recorded, cell)).toEqual({
      deltaAC: 1,
      deltaDC: 1,
      position: 'head',
      countsTowardLimit: 'yes',
      destructive: false,
    });
    const result = assertion(recorded, [cell]);
    expect(result).toMatchObject({
      evidence: { state: 'valid' },
      registry: { state: 'match' },
    });
  });

  it('AC-7 each era reads the counter headers as the fact sheet b.1 says', () => {
    // Same data for every era: x-delivery-count 1, x-acquired-count 0. Swapping the two headers on
    // 4.3, reading the 4.0-4.2 header as DC, or inventing an AC on 3.13 changes an answer here.
    const recorded = artefact((q) => (crossed(q) ? null : [1, 0, 0]));
    const on = (era: string) => projectDown01(recorded, cellOf(era, 'finite'));

    expect(on('4.3')).toMatchObject({ deltaAC: 0, deltaDC: 1 });
    expect(on('4.0-4.2')).toMatchObject({ deltaAC: 1 });
    expect(on('4.0-4.2')).not.toHaveProperty('deltaDC');
    expect(on('3.13')).toMatchObject({ deltaDC: 1 });
    expect(on('3.13')).not.toHaveProperty('deltaAC');
  });

  it('AC-8 a contradicting artefact fails the three-way assertion with the field diff', () => {
    // The counters did not move on 4.3 (the cell says AC 1 and DC 1).
    const recorded = artefact((q) => (crossed(q) ? null : [null, null, 0]));

    const result = assertion(recorded, [cellOf('4.3', 'finite')]);

    expect(result?.verdict).toBe('fail');
    expect(result?.registry).toMatchObject({
      state: 'mismatch',
      diffs: [{ path: 'effect.deltaAC' }, { path: 'effect.deltaDC' }],
    });
  });

  it('AC-9 countsTowardLimit and destructive come from survival after the limit is crossed', () => {
    const finite = cellOf('4.3', 'finite');
    // 3.13 with -1: dropped on the first return.
    const gone = artefact(() => null);
    expect(projectDown01(gone, cellOf('3.13', 'minus1'))).toEqual({
      position: 'dlx-or-drop',
      destructive: true,
      countsTowardLimit: 'yes',
    });
    const survives = (q: string): M1 => [3, 3, crossed(q) ? 0 : 1];
    expect(projectDown01(artefact(survives), finite)).toMatchObject({
      countsTowardLimit: 'no',
      position: 'tail',
    });
    // Survived, but round 2 held another message: m1 was not returned three times; say nothing.
    const other = artefact(survives, {
      holder: (q, round) =>
        q === 'fin-get-x' && round === 2 ? 'fin-get-x-m2' : `${q}-m1`,
    });
    expect(projectDown01(other, finite)).toBeNull();
    // -1 and survived: the return does not count.
    expect(
      projectDown01(
        artefact(() => [1, 1, 0]),
        cellOf('4.3', 'minus1'),
      ),
    ).toMatchObject({ countsTowardLimit: 'no' });
  });

  it('AC-10 diverging paths are reported, not averaged away', () => {
    // Cancel-then-close left the AC one higher than a get and an active consumer did.
    const differs = artefact((q) =>
      q === 'fin-cancelled' ? [1, 2, 0] : dropsOnCrossing(q),
    );
    // Closing the connection dropped the message the channel close kept.
    const conn = artefact((q) =>
      q === 'fin-conn' ? null : dropsOnCrossing(q),
    );
    const finite = cellOf('4.3', 'finite');

    expect(pathDivergence(artefact(dropsOnCrossing))).toEqual([]);
    expect(pathDivergence(differs)).toEqual([
      'finite: fin-cancelled differs from fin-get in x-acquired-count (2 vs 1)',
    ]);
    expect(pathDivergence(conn).join(' ')).toMatch(
      /fin-conn differs.*survived/,
    );
    expect(projectDown01(differs, finite)).toBeNull();
    expect(projectDown01(conn, finite)).toBeNull();
    // A limit whose paths agree is still projected, and a missing path is a finding.
    expect(projectDown01(differs, cellOf('3.13', 'minus1'))).not.toBeNull();
    expect(
      pathDivergence(artefact(dropsOnCrossing, { without: 'unset-active' })),
    ).toContain('unset: no reading of m1 in unset-active');
  });
});
