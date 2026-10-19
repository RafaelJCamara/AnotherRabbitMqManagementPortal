import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { evidenceBody, sealedEvidence } from '../testing/lab.ts';
import {
  EvidenceError,
  canonicalJson,
  evidenceJsonSchema,
  evidenceRelativePath,
  sealArtefact,
  verifyArtefact,
  verifyEvidenceText,
} from './evidence.ts';

const codeOf = (action: () => unknown): string | undefined => {
  try {
    action();
  } catch (error) {
    return error instanceof EvidenceError ? error.code : 'other';
  }
  return undefined;
};

const edit = (
  text: string,
  change: (value: Record<string, unknown>) => void,
): string => {
  const value = JSON.parse(text) as Record<string, unknown>;
  change(value);
  return JSON.stringify(value);
};

describe('I-14 an evidence artefact is tamper-evident', () => {
  const text = JSON.stringify(sealedEvidence());

  it('a sealed artefact verifies, from an object and from text', () => {
    expect(verifyArtefact(text).cfId).toBe('CF-SMOKE-01');
    expect(verifyArtefact(sealedEvidence()).brokerVersion).toBe('4.3.6');
  });

  it('flipping a recorded observation by hand no longer verifies', () => {
    const forged = edit(text, (value) => {
      (value.observations as { redelivered: boolean }[]).forEach((item) => {
        item.redelivered = false;
      });
    });

    expect(codeOf(() => verifyArtefact(forged))).toBe('tampered');
  });

  it.each([
    [
      'the broker version',
      (value: Record<string, unknown>) => {
        value.brokerVersion = '4.2.9';
      },
    ],
    [
      'the image digest',
      (value: Record<string, unknown>) => {
        value.imageDigest = `sha256:${'b'.repeat(64)}`;
      },
    ],
    [
      'a step',
      (value: Record<string, unknown>) => {
        (value.steps as { result: Record<string, unknown> }[]).forEach(
          (item) => {
            item.result.channelOpen = false;
          },
        );
      },
    ],
    [
      'the order of the steps',
      (value: Record<string, unknown>) => {
        (value.steps as unknown[]).push({
          index: 1,
          op: 'recover',
          args: {},
          result: {},
        });
        (value.steps as unknown[]).reverse();
      },
    ],
    [
      'the provenance run URL',
      (value: Record<string, unknown>) => {
        (value.provenance as Record<string, unknown>).runUrl =
          'https://github.com/example/repo/actions/runs/999';
      },
    ],
  ])('changing %s no longer verifies', (_name, change) => {
    expect(codeOf(() => verifyArtefact(edit(text, change)))).toBe('tampered');
  });

  it('an artefact whose digest was not recomputed, or is another one, is tampered', () => {
    const other = sealedEvidence((body) => ({ ...body, title: 'another' }));
    const swapped = edit(text, (value) => {
      value.integrity = other.integrity;
    });

    expect(codeOf(() => verifyArtefact(swapped))).toBe('tampered');
  });

  it('refuses an unknown field, a missing field, bad JSON and an unsupported schema version', () => {
    expect(
      codeOf(() =>
        verifyArtefact(
          edit(text, (value) => {
            value.extra = 1;
          }),
        ),
      ),
    ).toBe('malformed');
    expect(
      codeOf(() =>
        verifyArtefact(
          edit(text, (value) => {
            delete value.imageDigest;
          }),
        ),
      ),
    ).toBe('malformed');
    expect(
      codeOf(() =>
        verifyArtefact(
          edit(text, (value) => {
            value.schemaVersion = 2;
          }),
        ),
      ),
    ).toBe('malformed');
    expect(codeOf(() => verifyArtefact('{not json'))).toBe('malformed');
    expect(codeOf(() => verifyArtefact(null))).toBe('malformed');
  });

  it('sealing refuses a body the schema does not accept', () => {
    const bad = evidenceBody((body) => ({ ...body, cfId: '../CF-SMOKE-01' }));

    expect(codeOf(() => sealArtefact(bad))).toBe('malformed');
    expect(
      codeOf(() =>
        sealArtefact(
          evidenceBody((body) => ({ ...body, brokerVersion: '4.3' })),
        ),
      ),
    ).toBe('malformed');
    expect(
      codeOf(() =>
        sealArtefact(
          evidenceBody((body) => ({ ...body, imageDigest: 'latest' })),
        ),
      ),
    ).toBe('malformed');
  });

  it('a file moved under another version or another id is misplaced', () => {
    const artefact = sealedEvidence();

    expect(evidenceRelativePath(artefact)).toBe('4.3.6/CF-SMOKE-01.json');
    expect(verifyEvidenceText('4.3.6/CF-SMOKE-01.json', text).cfId).toBe(
      'CF-SMOKE-01',
    );
    expect(verifyEvidenceText('4.3.6\\CF-SMOKE-01.json', text).cfId).toBe(
      'CF-SMOKE-01',
    );
    expect(
      codeOf(() => verifyEvidenceText('4.2.9/CF-SMOKE-01.json', text)),
    ).toBe('misplaced');
    expect(
      codeOf(() => verifyEvidenceText('4.3.6/CF-SETTLE-01.json', text)),
    ).toBe('misplaced');
  });

  it('accepts a local stamp only with a null or a full git sha, and a CI stamp only with a run URL', () => {
    const local = (gitSha: unknown) =>
      sealArtefact(
        evidenceBody((body) => ({
          ...body,
          provenance: {
            kind: 'local',
            recorder: 'conformance:record',
            gitSha,
            recordedAt: '2026-10-19T12:00:00.000Z',
          } as never,
        })),
      );
    expect(local(null).provenance.kind).toBe('local');
    expect(codeOf(() => local('abc'))).toBe('malformed');
    expect(
      codeOf(() =>
        sealArtefact(
          evidenceBody((body) => ({
            ...body,
            provenance: {
              ...body.provenance,
              runUrl: 'http://example.com/x',
            } as never,
          })),
        ),
      ),
    ).toBe('malformed');
  });
});

describe('canonical JSON', () => {
  it('does not depend on the order of keys', () => {
    expect(
      canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } }),
    ).toBe(canonicalJson({ a: { c: null, d: [2, { y: 2, z: 1 }] }, b: 1 }));
    expect(canonicalJson({ b: 1, a: 'x' })).toBe('{"a":"x","b":1}');
  });

  it('refuses what JSON cannot say', () => {
    expect(codeOf(() => canonicalJson({ n: Number.NaN }))).toBe('malformed');
    expect(codeOf(() => canonicalJson({ n: Number.POSITIVE_INFINITY }))).toBe(
      'malformed',
    );
    expect(codeOf(() => canonicalJson({ f: () => 1 }))).toBe('malformed');
    expect(codeOf(() => canonicalJson({ u: undefined }))).toBe('malformed');
    expect(codeOf(() => canonicalJson({ n: 10n }))).toBe('malformed');
  });
});

describe('the JSON schema for testing/lab-evidence/schema.json', () => {
  it('print-schema.ts prints exactly this schema, so a maintainer can commit the file', () => {
    const printed = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./print-schema.ts', import.meta.url))],
      { encoding: 'utf8' },
    );

    expect(printed.status, printed.stderr).toBe(0);
    expect(JSON.parse(printed.stdout)).toEqual(evidenceJsonSchema());
  });

  it('describes the artefact: required fields, no extras, the steps and the observations', () => {
    const schema = evidenceJsonSchema() as {
      type: string;
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, unknown>;
    };

    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(
      expect.arrayContaining([
        'cfId',
        'brokerVersion',
        'imageDigest',
        'steps',
        'observations',
        'provenance',
        'integrity',
      ]),
    );
    expect(Object.keys(schema.properties)).toContain('integrity');
  });
});
