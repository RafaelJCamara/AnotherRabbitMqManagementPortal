import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  digestOf,
  EvidenceFormatError,
  parseEvidence,
} from './evidence-format.ts';
import { fakeEvidence } from './testing.ts';

const codeOf = (action: () => unknown): string | undefined => {
  try {
    action();
  } catch (error) {
    return error instanceof EvidenceFormatError ? error.code : 'other';
  }
  return undefined;
};

describe('evidence format reader', () => {
  const good = fakeEvidence();
  const edit = (change: (value: Record<string, unknown>) => void): string => {
    const value = JSON.parse(good.text) as Record<string, unknown>;
    change(value);
    return JSON.stringify(value);
  };

  it('reads a sealed artefact that sits where its content says', () => {
    const evidence = parseEvidence(good.path, good.text);

    expect(evidence.cfId).toBe('CF-SMOKE-01');
    expect(
      parseEvidence('4.3.6\\CF-SMOKE-01.json', good.text).brokerVersion,
    ).toBe('4.3.6');
  });

  it.each([
    ['text that is not JSON', 'nope', 'malformed'],
    ['an extra field', edit((v) => (v.note = 'x')), 'malformed'],
    ['a missing field', edit((v) => delete v.title), 'malformed'],
    [
      'an unknown schema version',
      edit((v) => (v.schemaVersion = 2)),
      'malformed',
    ],
    ['a flipped observation', edit((v) => (v.steps = [])), 'tampered'],
    [
      'a swapped digest',
      edit(
        (v) => (v.integrity = { algorithm: 'sha256', digest: '0'.repeat(64) }),
      ),
      'tampered',
    ],
    [
      'a stamp changed after sealing',
      edit(
        (v) =>
          ((v.provenance as Record<string, unknown>).gitSha = 'f'.repeat(40)),
      ),
      'tampered',
    ],
  ])('refuses %s', (_name, text, code) => {
    expect(codeOf(() => parseEvidence(good.path, text))).toBe(code);
  });

  it('refuses a file filed under another version or another id', () => {
    expect(
      codeOf(() => parseEvidence('4.2.9/CF-SMOKE-01.json', good.text)),
    ).toBe('misplaced');
    expect(
      codeOf(() => parseEvidence('4.3.6/CF-OTHER-01.json', good.text)),
    ).toBe('misplaced');
  });

  it('writes the same bytes for the same value whatever the key order, and refuses values that are not JSON', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(
      '{"a":[2,{"c":2,"d":1}],"b":1}',
    );
    expect(digestOf({ a: 1, b: 2 })).toBe(digestOf({ b: 2, a: 1 }));
    expect(codeOf(() => canonicalJson({ a: Number.NaN }))).toBe('malformed');
    expect(codeOf(() => canonicalJson({ a: undefined }))).toBe('malformed');
  });
});
