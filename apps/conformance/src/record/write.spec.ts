// The writer is tested in temporary folders only. The real `testing/lab-evidence` is never touched:
// the "canonical root" of these tests is a temporary folder that plays its part.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { localProvenance, sealedEvidence } from '../testing/lab.ts';
import { EvidenceError, verifyEvidenceText } from './evidence.ts';
import { isInside, writeEvidence } from './write.ts';

let scratch: string;
let canonical: string;
let elsewhere: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'evidence-write-'));
  canonical = join(scratch, 'testing', 'lab-evidence');
  elsewhere = join(scratch, 'elsewhere');
  mkdirSync(canonical, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const codeOf = (action: () => unknown): string | undefined => {
  try {
    action();
  } catch (error) {
    return error instanceof EvidenceError ? error.code : 'other';
  }
  return undefined;
};

const local = () =>
  sealedEvidence((body) => ({ ...body, provenance: localProvenance }));

describe('A-20 the writer writes one verified artefact below its root', () => {
  it('writes <root>/<version>/<CF-id>.json, and the file verifies where it lies', () => {
    const root = join(scratch, 'out');

    const file = writeEvidence(sealedEvidence(), {
      root,
      canonicalRoot: canonical,
    });

    expect(file).toBe(join(root, '4.3.6', 'CF-SMOKE-01.json'));
    const text = readFileSync(file, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(verifyEvidenceText('4.3.6/CF-SMOKE-01.json', text).cfId).toBe(
      'CF-SMOKE-01',
    );
    expect(readdirSync(join(root, '4.3.6'))).toEqual(['CF-SMOKE-01.json']);
  });

  it('writes a ci artefact into the canonical root, and replaces an older recording without leaving a temporary file', () => {
    writeEvidence(sealedEvidence(), {
      root: canonical,
      canonicalRoot: canonical,
    });
    const second = sealedEvidence((body) => ({
      ...body,
      title: 'second recording',
    }));

    const file = writeEvidence(second, {
      root: canonical,
      canonicalRoot: canonical,
    });

    expect(
      verifyEvidenceText('4.3.6/CF-SMOKE-01.json', readFileSync(file, 'utf8'))
        .title,
    ).toBe('second recording');
    expect(readdirSync(join(canonical, '4.3.6'))).toEqual(['CF-SMOKE-01.json']);
  });

  it('I-14 refuses to write a local artefact into the evidence tree, however the folder is spelled', () => {
    const spellings = [
      canonical,
      join(canonical, '4.3.6'),
      join(canonical, 'new-folder'),
      join(canonical, '..', 'lab-evidence'),
      join(scratch, 'testing', '.', 'lab-evidence'),
      // Windows and macOS file systems ignore case; Linux is filtered out below.
      canonical.toLowerCase(),
    ];

    for (const root of spellings.filter((spelling) =>
      isInside(canonical, spelling),
    )) {
      expect(
        codeOf(() =>
          writeEvidence(local(), { root, canonicalRoot: canonical }),
        ),
      ).toBe('refused');
    }
    expect(readdirSync(canonical)).toEqual([]);
  });

  it('I-14 refuses a local artefact through a link that leads into the evidence tree', () => {
    const link = join(scratch, 'link-to-evidence');
    symlinkSync(canonical, link, 'junction');

    expect(
      codeOf(() =>
        writeEvidence(local(), { root: link, canonicalRoot: canonical }),
      ),
    ).toBe('refused');
    expect(readdirSync(canonical)).toEqual([]);
  });

  it('writes a local artefact anywhere else', () => {
    const file = writeEvidence(local(), {
      root: join(scratch, 'out'),
      canonicalRoot: canonical,
    });

    expect(existsSync(file)).toBe(true);
  });

  it('refuses to write through a version folder that is a link to another folder', () => {
    const root = join(scratch, 'out');
    mkdirSync(root);
    symlinkSync(elsewhere, join(root, '4.3.6'), 'junction');

    expect(
      codeOf(() =>
        writeEvidence(sealedEvidence(), { root, canonicalRoot: canonical }),
      ),
    ).toBe('refused');
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('refuses an artefact that was edited after sealing, and writes nothing', () => {
    const edited = { ...sealedEvidence(), title: 'edited' };

    expect(
      codeOf(() =>
        writeEvidence(edited, {
          root: join(scratch, 'out'),
          canonicalRoot: canonical,
        }),
      ),
    ).toBe('tampered');
    expect(existsSync(join(scratch, 'out', '4.3.6'))).toBe(false);
  });

  it('I-10 refuses an artefact that holds a secret, a known login or a credential key, and writes nothing', () => {
    const withSecret = (change: (result: Record<string, unknown>) => void) =>
      sealedEvidence((body) => ({
        ...body,
        steps: body.steps.map((step) => {
          const result = { ...step.result };
          change(result);
          return { ...step, result };
        }),
      }));
    const root = join(scratch, 'out');

    expect(
      codeOf(() =>
        writeEvidence(
          withSecret((result) => {
            result.text = 'amqp://u:p@h';
          }),
          { root, canonicalRoot: canonical },
        ),
      ),
    ).toBe('secret');
    expect(
      codeOf(() =>
        writeEvidence(
          withSecret((result) => {
            result.text = 'login failed for hunter2';
          }),
          {
            root,
            canonicalRoot: canonical,
            knownSecrets: ['hunter2'],
          },
        ),
      ),
    ).toBe('secret');
    expect(
      codeOf(() =>
        writeEvidence(
          withSecret((result) => {
            result.password = 'x';
          }),
          { root, canonicalRoot: canonical },
        ),
      ),
    ).toBe('secret');
    expect(existsSync(root)).toBe(false);
  });
});

describe('isInside', () => {
  it('is true for the folder and what is below it, false for a sibling that shares a prefix and for a parent', () => {
    mkdirSync(join(scratch, 'a'));
    mkdirSync(join(scratch, 'ab'));
    writeFileSync(join(scratch, 'a', 'f'), '');

    expect(isInside(join(scratch, 'a'), join(scratch, 'a'))).toBe(true);
    expect(isInside(join(scratch, 'a'), join(scratch, 'a', 'f'))).toBe(true);
    expect(
      isInside(join(scratch, 'a'), join(scratch, 'a', 'not', 'yet', 'there')),
    ).toBe(true);
    expect(isInside(join(scratch, 'a'), join(scratch, 'ab'))).toBe(false);
    expect(isInside(join(scratch, 'a'), scratch)).toBe(false);
    expect(isInside(join(scratch, 'a'), join(scratch, 'a', '..', 'ab'))).toBe(
      false,
    );
  });
});
