// The semantics-evidence check reads evidence with its own code (tools/semantics-evidence cannot
// import an application). This proves the two readers accept the same artefacts and refuse the same
// edits, so the format cannot change in one place only: a schema change here makes this spec fail
// until the check's reader is changed too.
import {
  canonicalJson as checkCanonical,
  parseEvidence,
} from '@app/semantics-evidence';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  sealArtefact,
  verifyEvidenceText,
  type EvidenceProvenance,
} from '../record/evidence.ts';
import { evidenceBody } from '../testing/lab.ts';

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
  recordedAt: CI.recordedAt,
};

const recorderAccepts = (path: string, text: string): boolean => {
  try {
    verifyEvidenceText(path, text);
    return true;
  } catch {
    return false;
  }
};
const checkAccepts = (path: string, text: string): boolean => {
  try {
    parseEvidence(path, text);
    return true;
  } catch {
    return false;
  }
};

type Mutable = Record<string, unknown>;

/** The object at key, or the first item when it is an array. */
function child(parent: Mutable, key: string): Mutable {
  const found = parent[key];
  const item = Array.isArray(found) ? (found as unknown[])[0] : found;
  if (typeof item !== 'object' || item === null) throw new Error('no ' + key);
  return item as Mutable;
}

function corpus(): { name: string; path: string; text: string }[] {
  const out: { name: string; path: string; text: string }[] = [];
  const path = '4.3.6/CF-SMOKE-01.json';
  const add = (name: string, text: string, at = path): void => {
    out.push({ name, path: at, text });
  };
  for (const provenance of [CI, LOCAL]) {
    const sealed = sealArtefact(
      evidenceBody((body) => ({ ...body, provenance })),
    );
    const text = JSON.stringify(sealed);
    add(`valid ${provenance.kind}`, text);
    add(`pretty ${provenance.kind}`, JSON.stringify(sealed, null, 2));
    add(
      `${provenance.kind} filed under another version`,
      text,
      '4.2.9/CF-SMOKE-01.json',
    );
    add(
      `${provenance.kind} filed under another id`,
      text,
      '4.3.6/CF-OTHER-01.json',
    );
    const edits: [string, (v: Mutable) => void][] = [
      ['extra top-level field', (v) => (v.note = 1)],
      ['extra provenance field', (v) => ((v.provenance as Mutable).note = 1)],
      ['extra integrity field', (v) => ((v.integrity as Mutable).note = 1)],
      ['extra step field', (v) => (child(v, 'steps').note = 1)],
      ['extra observation field', (v) => (child(v, 'observations').note = 1)],
      ['schema version 2', (v) => (v.schemaVersion = 2)],
      ['bad cf id', (v) => (v.cfId = 'smoke')],
      ['bad broker version', (v) => (v.brokerVersion = '4.3')],
      ['bad protocol', (v) => (v.protocol = 'mqtt')],
      ['bad image digest', (v) => (v.imageDigest = 'sha256:abc')],
      ['empty title', (v) => (v.title = '')],
      ['steps not an array', (v) => (v.steps = {})],
      ['negative step index', (v) => (child(v, 'steps').index = -1)],
      ['bad git sha', (v) => ((v.provenance as Mutable).gitSha = 'xyz')],
      [
        'bad run url',
        (v) =>
          ((v.provenance as Mutable).runUrl =
            'http://github.com/a/b/actions/runs/1'),
      ],
      [
        'run url with a login',
        (v) =>
          ((v.provenance as Mutable).runUrl =
            'https://u@github.com/a/b/actions/runs/1'),
      ],
      ['bad recorder', (v) => ((v.provenance as Mutable).recorder = 'hand')],
      ['bad time', (v) => ((v.provenance as Mutable).recordedAt = 'yesterday')],
      [
        'unknown provenance kind',
        (v) => ((v.provenance as Mutable).kind = 'bot'),
      ],
      [
        'uppercase digest',
        (v) =>
          ((v.integrity as Mutable).digest = String(
            (v.integrity as Mutable).digest,
          ).toUpperCase()),
      ],
      ['short digest', (v) => ((v.integrity as Mutable).digest = 'ab')],
      ['other algorithm', (v) => ((v.integrity as Mutable).algorithm = 'md5')],
      ['missing integrity', (v) => delete v.integrity],
      ['missing steps', (v) => delete v.steps],
      [
        'missing provenance field',
        (v) => delete (v.provenance as Mutable).recordedAt,
      ],
      [
        'step result changed',
        (v) => (child(child(v, 'steps'), 'result').channelOpen = false),
      ],
      ['observation changed', (v) => (child(v, 'observations').position = 9)],
      [
        'observation with a fractional count',
        (v) => (child(v, 'observations')['x-delivery-count'] = 1.5),
      ],
    ];
    for (const [name, edit] of edits) {
      const copy = JSON.parse(text) as Mutable;
      edit(copy);
      add(`${provenance.kind}: ${name}`, JSON.stringify(copy));
    }
  }
  add('not JSON', 'nope');
  add('empty', '');
  add('an array', '[]');
  add('null', 'null');
  return out;
}

describe('evidence format: the recorder and the check read it the same way', () => {
  const cases = corpus();

  it('AC-1 the corpus is large and has both outcomes', () => {
    expect(cases.length).toBeGreaterThan(55);
    expect(
      cases.filter((item) => recorderAccepts(item.path, item.text)).length,
    ).toBeGreaterThanOrEqual(4);
    expect(
      cases.filter((item) => !recorderAccepts(item.path, item.text)).length,
    ).toBeGreaterThan(40);
  });

  it.each(cases.map((item) => [item.name, item] as const))(
    'AC-1 accepts or refuses alike: %s',
    (_name, item) => {
      expect(checkAccepts(item.path, item.text)).toBe(
        recorderAccepts(item.path, item.text),
      );
    },
  );

  it('AC-1 computes the same canonical bytes and digest', () => {
    const value = { b: [1, { y: null, x: 'é' }], a: true, c: 1e21 };

    expect(checkCanonical(value)).toBe(canonicalJson(value));
  });
});
