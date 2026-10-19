import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { eraOfVersion, labVersions } from './lab-versions.ts';
import { appendReport } from './report.ts';
import type { CellResult } from './three-way.ts';

const folder = mkdtempSync(join(tmpdir(), 'conformance-report-'));
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

const result = (cfId: string): CellResult => ({
  cellId: null,
  cfId,
  version: '4.3.6',
  live: { state: 'not-run' },
  evidence: { state: 'missing', path: `4.3.6/${cfId}.json` },
  registry: { state: 'no-cell' },
  verdict: 'unverified',
  reasons: ['no evidence'],
});

describe('report', () => {
  it('AC-2 appends one JSON line per result, across calls', () => {
    const file = join(folder, 'a.jsonl');

    appendReport(file, [result('CF-A-01'), result('CF-B-01')]);
    appendReport(file, [result('CF-C-01')]);

    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(lines.map((line) => (JSON.parse(line) as CellResult).cfId)).toEqual([
      'CF-A-01',
      'CF-B-01',
      'CF-C-01',
    ]);
  });

  it('writes nothing without a file or without results', () => {
    const file = join(folder, 'b.jsonl');

    appendReport(undefined, [result('CF-A-01')]);
    appendReport('', [result('CF-A-01')]);
    appendReport(file, []);

    expect(() => readFileSync(file)).toThrow();
  });
});

describe('lab versions', () => {
  it('maps every pinned lab version to the semantics era the registry resolves for it', () => {
    expect(labVersions().map(({ version, era }) => [version, era])).toEqual([
      ['3.13.7', '3.13'],
      ['4.0.9', '4.0-4.2'],
      ['4.1.8', '4.0-4.2'],
      ['4.2.9', '4.0-4.2'],
      ['4.3.6', '4.3'],
    ]);
    expect(
      labVersions().every((lab) => /^sha256:[0-9a-f]{64}$/.test(lab.digest)),
    ).toBe(true);
  });

  it('refuses a version that is not a version', () => {
    expect(() => eraOfVersion('four')).toThrow('not a broker version');
  });
});
