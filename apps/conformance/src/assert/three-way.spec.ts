// The three-way assertion against an in-memory broker and fake evidence in temporary folders. Each
// test tries to get a disagreement through (or a pass without evidence) and shows it is refused.
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SemanticsCell } from '@app/semantics';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runScenario } from '../dsl.ts';
import {
  sealArtefact,
  type EvidenceBody,
  type EvidenceProvenance,
} from '../record/evidence.ts';
import { cfSmoke01 } from '../scenarios/cf-smoke-01.ts';
import { DIGEST, MemoryHost, VERSION } from '../testing/lab.ts';
import { readEvidenceFile } from './evidence-store.ts';
import { projectSmoke01 } from './projections.ts';
import {
  assertResult,
  evaluate,
  formatResult,
  type CellResult,
  type EvaluateInput,
  type EvidenceFile,
  type LiveRun,
} from './three-way.ts';

const CI: EvidenceProvenance = {
  kind: 'ci',
  recorder: 'conformance:record',
  gitSha: 'a'.repeat(40),
  runUrl: 'https://github.com/acme/portal/actions/runs/1/attempts/1',
  workflow:
    'acme/portal/.github/workflows/conformance-record.yml@refs/heads/main',
  recordedAt: '2026-10-19T10:00:00.000Z',
};
const LOCAL: EvidenceProvenance = {
  kind: 'local',
  recorder: 'conformance:record',
  gitSha: null,
  recordedAt: '2026-10-19T10:00:00.000Z',
};

const EFFECT = {
  deltaAC: 1,
  deltaDC: 0,
  countsTowardLimit: 'no',
  position: 'head',
  destructive: false,
} as const;

const cell = (change: Partial<SemanticsCell> = {}): SemanticsCell => ({
  id: 'SEM-4.3-classic-amqp091-nack',
  key: {
    era: '4.3',
    queueType: 'classic',
    protocol: 'amqp091',
    action: 'amqp091.nack_requeue',
  },
  effect: { ...EFFECT },
  citations: [],
  conformance: ['CF-SMOKE-01'],
  status: 'code-derived',
  evidence: [],
  ...change,
});

async function liveRun(host: MemoryHost = new MemoryHost()): Promise<LiveRun> {
  const run = await runScenario(host, cfSmoke01, 'r1');
  return {
    cfId: cfSmoke01.cfId,
    title: cfSmoke01.title,
    protocol: cfSmoke01.protocol,
    brokerVersion: VERSION,
    imageDigest: DIGEST,
    steps: run.steps,
    observations: run.observations,
  };
}

const bodyOf = (
  live: LiveRun,
  change: Partial<EvidenceBody> = {},
): EvidenceBody => ({
  schemaVersion: 1,
  cfId: live.cfId,
  title: live.title,
  protocol: 'amqp091',
  brokerVersion: live.brokerVersion,
  imageDigest: live.imageDigest,
  steps: [...live.steps],
  observations: [...live.observations],
  provenance: CI,
  ...change,
});

const present = (
  body: EvidenceBody,
  path = `${VERSION}/CF-SMOKE-01.json`,
): EvidenceFile => ({
  kind: 'present',
  path,
  text: JSON.stringify(sealArtefact(body)),
});

function input(change: Partial<EvaluateInput>): EvaluateInput {
  return {
    cfId: 'CF-SMOKE-01',
    version: VERSION,
    era: '4.3',
    pin: DIGEST,
    cells: [],
    file: { kind: 'missing', path: `${VERSION}/CF-SMOKE-01.json` },
    live: null,
    projection: projectSmoke01,
    ...change,
  };
}

const only = (results: readonly CellResult[]): CellResult => {
  expect(results).toHaveLength(1);
  const [first] = results;
  if (first === undefined) throw new Error('no result');
  return first;
};

describe('three-way assertion: the legs agree', () => {
  it('AC-2 passes when the live run, the recorded evidence and the registry cell agree', async () => {
    const live = await liveRun();

    const result = only(
      evaluate(input({ file: present(bodyOf(live)), live, cells: [cell()] })),
    );

    expect(result).toMatchObject({
      verdict: 'pass',
      cellId: 'SEM-4.3-classic-amqp091-nack',
      live: { state: 'match' },
      registry: { state: 'match' },
      evidence: { state: 'valid' },
      reasons: [],
    });
  });

  it('AC-2 is only unverified when no evidence is recorded yet, whatever the live run does', async () => {
    const live = await liveRun();

    const result = only(evaluate(input({ live, cells: [cell()] })));

    expect(result.verdict).toBe('unverified');
    expect(result.evidence.state).toBe('missing');
    expect(result.live.state).toBe('no-baseline');
    expect(result.reasons.join()).toContain(
      'no evidence is recorded at testing/lab-evidence/4.3.6/CF-SMOKE-01.json',
    );
  });

  it('is only unverified without a live run, without a registry cell, without a derived effect and without a projection', async () => {
    const live = await liveRun();
    const file = present(bodyOf(live));

    const noLive = only(evaluate(input({ file, cells: [cell()] })));
    const noCell = only(evaluate(input({ file, live })));
    const noEffect = only(
      evaluate(input({ file, live, cells: [cell({ effect: null })] })),
    );
    const noProjection = only(
      evaluate(input({ file, live, cells: [cell()], projection: undefined })),
    );
    const silent = only(
      evaluate(input({ file, live, cells: [cell()], projection: () => null })),
    );
    const empty = only(
      evaluate(input({ file, live, cells: [cell()], projection: () => ({}) })),
    );

    expect(noLive).toMatchObject({
      verdict: 'unverified',
      live: { state: 'not-run' },
      registry: { state: 'match' },
    });
    expect(noCell).toMatchObject({
      verdict: 'unverified',
      cellId: null,
      registry: { state: 'no-cell' },
    });
    expect(noEffect).toMatchObject({
      verdict: 'unverified',
      registry: { state: 'no-effect' },
    });
    expect(noProjection.registry.state).toBe('no-projection');
    expect(silent.registry.state).toBe('no-projection');
    expect(empty.registry.state).toBe('no-projection');
    for (const result of [noProjection, silent, empty])
      expect(result.verdict).toBe('unverified');
  });

  it('evaluates every cell that names the id for the era, and no cell of another era or id', async () => {
    const live = await liveRun();

    const results = evaluate(
      input({
        file: present(bodyOf(live)),
        live,
        cells: [
          cell(),
          cell({
            id: 'SEM-2',
            key: { ...cell().key, action: 'amqp091.reject_requeue' },
          }),
          cell({ id: 'SEM-other-era', key: { ...cell().key, era: '3.13' } }),
          cell({ id: 'SEM-other-cf', conformance: ['CF-OTHER-01'] }),
        ],
      }),
    );

    expect(results.map((result) => result.cellId)).toEqual([
      'SEM-4.3-classic-amqp091-nack',
      'SEM-2',
    ]);
  });
});

describe('three-way assertion: live run against the recorded evidence', () => {
  class ForgetfulHost extends MemoryHost {
    override async settle(...args: Parameters<MemoryHost['settle']>) {
      const outcome = await super.settle(...args);
      for (const messages of this.queues.values()) {
        for (const message of messages) message.redelivered = false;
      }
      return outcome;
    }
  }

  it('AC-2 fails with a field-level diff when the live run differs from the recorded evidence', async () => {
    const recorded = await liveRun();
    const live = await liveRun(new ForgetfulHost());

    const result = only(
      evaluate(
        input({ file: present(bodyOf(recorded)), live, cells: [cell()] }),
      ),
    );

    expect(result.verdict).toBe('fail');
    if (result.live.state !== 'mismatch')
      throw new Error('expected a mismatch');
    expect(result.live.diffs.map((diff) => diff.path)).toEqual([
      '$.observations[0].redelivered',
    ]);
    expect(result.live.diffs[0]).toEqual({
      path: '$.observations[0].redelivered',
      expected: true,
      actual: false,
    });
    expect(formatResult(result)).toContain(
      '$.observations[0].redelivered: recorded true, live false',
    );
    expect(() => {
      assertResult(result, { strict: false });
    }).toThrow('$.observations[0].redelivered: recorded true, live false');
  });

  it('AC-2 fails when the live broker is on another image or the scenario changed since the recording', async () => {
    const recorded = await liveRun();
    const live: LiveRun = {
      ...recorded,
      imageDigest: `sha256:${'9'.repeat(64)}`,
      title: 'a new title',
    };

    const result = only(
      evaluate(input({ file: present(bodyOf(recorded)), live })),
    );

    expect(result.verdict).toBe('fail');
    const text = formatResult(result);
    expect(text).toContain('$.imageDigest');
    expect(text).toContain('$.title: recorded');
  });

  it('AC-2 fails a live run that did one step fewer', async () => {
    const recorded = await liveRun();
    const live: LiveRun = { ...recorded, steps: recorded.steps.slice(0, -1) };

    const result = only(
      evaluate(input({ file: present(bodyOf(recorded)), live })),
    );

    expect(result.verdict).toBe('fail');
    expect(formatResult(result)).toContain('$.steps[5]: recorded');
    expect(formatResult(result)).toContain('(absent)');
  });
});

describe('three-way assertion: the recorded evidence', () => {
  it('AC-2 fails evidence that does not verify, is local, is for another id or version, or sits on another image', async () => {
    const live = await liveRun();
    const good = present(bodyOf(live));
    if (good.kind !== 'present') throw new Error('unreachable');
    const failures = [
      [
        'tampered',
        { ...good, text: good.text.replace('"ok":true', '"ok":false') },
        'does not match',
      ],
      ['not JSON', { ...good, text: 'nope' }, 'not valid JSON'],
      [
        'local',
        present(bodyOf(live, { provenance: LOCAL })),
        'provenance is local',
      ],
      [
        'misplaced',
        present(bodyOf(live), '4.2.9/CF-SMOKE-01.json'),
        'holds the evidence of',
      ],
      [
        'unpinned',
        present(bodyOf(live, { imageDigest: `sha256:${'8'.repeat(64)}` })),
        'not the pinned',
      ],
      [
        'a link',
        { kind: 'unreadable', path: good.path } as const,
        'link or too large',
      ],
    ] as const;

    for (const [name, file, reason] of failures) {
      const result = only(evaluate(input({ file, live, cells: [cell()] })));
      expect(result.verdict, name).toBe('fail');
      expect(result.evidence.state, name).toBe('invalid');
      expect(result.registry.state, name).toBe('not-checked');
      expect(formatResult(result), name).toContain(reason);
    }
  });

  it('AC-2 fails evidence of another id placed where this id belongs', async () => {
    const live = await liveRun();
    const other = bodyOf(live, { cfId: 'CF-OTHER-01' });

    const result = only(
      evaluate(input({ file: present(other, `${VERSION}/CF-SMOKE-01.json`) })),
    );

    expect(result.verdict).toBe('fail');
  });
});

describe('three-way assertion: the registry cell against the evidence', () => {
  it('AC-2 fails when the cell says something the evidence does not, naming the field', async () => {
    const live = await liveRun();

    const result = only(
      evaluate(
        input({
          file: present(bodyOf(live)),
          live,
          cells: [cell({ effect: { ...EFFECT, position: 'tail' } })],
        }),
      ),
    );

    expect(result.verdict).toBe('fail');
    expect(formatResult(result)).toContain(
      'effect.position: registry "tail", evidence "head"',
    );
    expect(() => {
      assertResult(result, { strict: false });
    }).toThrow('effect.position');
  });

  it('AC-2 fails when the evidence shows the message lost and the cell says it is kept', async () => {
    const live = await liveRun();
    const lost = bodyOf(live, {
      observations: live.observations.map((item) =>
        item.messageId === 'm1'
          ? { ...item, survived: false, position: null, redelivered: null }
          : item,
      ),
    });

    const result = only(
      evaluate(input({ file: present(lost), cells: [cell()] })),
    );

    expect(result.verdict).toBe('fail');
    expect(formatResult(result)).toContain(
      'effect.destructive: registry false, evidence true',
    );
  });

  it('fails a lab status the evidence does not carry, and a contradicted cell, and passes a confirmed lab-verified one', async () => {
    const live = await liveRun();
    const file = present(bodyOf(live));
    const missing: EvidenceFile = {
      kind: 'missing',
      path: `${VERSION}/CF-SMOKE-01.json`,
    };

    const noEvidence = only(
      evaluate(
        input({
          file: missing,
          live,
          cells: [cell({ status: 'lab-verified' })],
        }),
      ),
    );
    const noProjection = only(
      evaluate(
        input({
          file,
          live,
          cells: [cell({ status: 'lab-verified' })],
          projection: undefined,
        }),
      ),
    );
    const noEffect = only(
      evaluate(
        input({
          file,
          live,
          cells: [cell({ status: 'lab-verified', effect: null })],
        }),
      ),
    );
    const contradictedAndMatching = only(
      evaluate(
        input({ file, live, cells: [cell({ status: 'lab-contradicted' })] }),
      ),
    );
    const contradictedAndWrong = only(
      evaluate(
        input({
          file,
          live,
          cells: [
            cell({
              status: 'lab-contradicted',
              effect: { ...EFFECT, position: 'tail' },
            }),
          ],
        }),
      ),
    );
    const confirmed = only(
      evaluate(
        input({ file, live, cells: [cell({ status: 'lab-verified' })] }),
      ),
    );

    expect(noEvidence.verdict).toBe('fail');
    expect(noEvidence.reasons.join()).toContain(
      'lab-verified but has no valid recorded evidence',
    );
    expect(noProjection.verdict).toBe('fail');
    expect(noEffect.verdict).toBe('fail');
    expect(contradictedAndMatching.verdict).toBe('fail');
    expect(contradictedAndMatching.reasons.join()).toContain(
      'lab-contradicted',
    );
    expect(contradictedAndWrong.verdict).toBe('fail');
    expect(confirmed.verdict).toBe('pass');
  });
});

describe('three-way assertion: outcome', () => {
  it('assertResult throws on a fail, and on unverified only when strict', async () => {
    const live = await liveRun();
    const unverified = only(evaluate(input({ live })));
    const fail = only(
      evaluate(
        input({ live, file: present(bodyOf(live, { provenance: LOCAL })) }),
      ),
    );
    const pass = only(
      evaluate(input({ live, file: present(bodyOf(live)), cells: [cell()] })),
    );

    expect(() => {
      assertResult(unverified, { strict: false });
    }).not.toThrow();
    expect(() => {
      assertResult(unverified, { strict: true });
    }).toThrow('unverified');
    expect(() => {
      assertResult(fail, { strict: false });
    }).toThrow('provenance is local');
    expect(() => {
      assertResult(pass, { strict: true });
    }).not.toThrow();
  });
});

describe('evidence store', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'conformance-store-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const put = (path: string, text: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };

  it('reads a present file, reports a missing one, and refuses a link', () => {
    put('4.3.6/CF-SMOKE-01.json', '{}');
    put('real.json', '{}');
    let linked = true;
    try {
      symlinkSync(
        join(root, 'real.json'),
        join(root, '4.3.6', 'CF-LINK-01.json'),
      );
    } catch {
      linked = false; // no permission to make links here (Windows without developer mode)
    }

    expect(readEvidenceFile(root, '4.3.6', 'CF-SMOKE-01')).toEqual({
      kind: 'present',
      path: '4.3.6/CF-SMOKE-01.json',
      text: '{}',
    });
    expect(readEvidenceFile(root, '4.3.6', 'CF-NONE-01')).toEqual({
      kind: 'missing',
      path: '4.3.6/CF-NONE-01.json',
    });
    if (linked) {
      expect(readEvidenceFile(root, '4.3.6', 'CF-LINK-01').kind).toBe(
        'unreadable',
      );
    }
  });

  it('does not read a folder or a file larger than any evidence file', () => {
    mkdirSync(join(root, '4.3.6', 'CF-DIR-01.json'), { recursive: true });
    put('4.3.6/CF-BIG-01.json', 'x'.repeat(4 * 1024 * 1024 + 1));
    put('4.3.6/CF-EDGE-01.json', 'x'.repeat(4 * 1024 * 1024));

    expect(readEvidenceFile(root, '4.3.6', 'CF-DIR-01').kind).toBe(
      'unreadable',
    );
    expect(readEvidenceFile(root, '4.3.6', 'CF-BIG-01').kind).toBe(
      'unreadable',
    );
    expect(readEvidenceFile(root, '4.3.6', 'CF-EDGE-01').kind).toBe('present');
  });

  it('refuses names that could leave the folder', () => {
    expect(() => readEvidenceFile(root, '../4.3.6', 'CF-SMOKE-01')).toThrow(
      'not a broker version',
    );
    expect(() => readEvidenceFile(root, '4.3.6', '../CF-SMOKE-01')).toThrow(
      'not a broker version',
    );
  });
});

describe('projections', () => {
  const observation = (position: number | null, survived = true) => ({
    name: 'after',
    messageId: 'm1',
    survived,
    position,
    redelivered: survived ? true : null,
    'x-delivery-count': null,
    'x-acquired-count': null,
  });
  const artefact = async (observations: ReturnType<typeof observation>[]) => {
    const live = await liveRun();
    return sealArtefact(bodyOf(live, { observations }));
  };

  it('CF-SMOKE-01 reads head, tail, in between and lost off the observations alone', async () => {
    const second = { ...observation(1), messageId: 'm2' };

    expect(
      projectSmoke01(await artefact([observation(0), second]), cell()),
    ).toEqual({ position: 'head', destructive: false });
    expect(
      projectSmoke01(
        await artefact([{ ...observation(1) }, { ...second, position: 0 }]),
        cell(),
      ),
    ).toEqual({ position: 'tail', destructive: false });
    expect(
      projectSmoke01(
        await artefact([
          observation(1),
          { ...second, position: 0 },
          { ...second, messageId: 'm3', position: 2 },
        ]),
        cell(),
      ),
    ).toEqual({ position: 'original', destructive: false });
    expect(
      projectSmoke01(
        await artefact([observation(null, false), second]),
        cell(),
      ),
    ).toEqual({ position: 'removed', destructive: true });
    expect(projectSmoke01(await artefact([second]), cell())).toBeNull();
  });
});
