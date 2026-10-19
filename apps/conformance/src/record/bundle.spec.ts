import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DIGEST, evidenceBody, localProvenance } from '../testing/lab.ts';
import {
  BundleError,
  MAX_ARTEFACT_BYTES,
  MAX_ARTEFACTS,
  checkBundle,
  expectationFromEnv,
  parseRecordInputs,
  renderPrBody,
  type RunExpectation,
} from './bundle.ts';
import {
  sealArtefact,
  verifyEvidenceText,
  type EvidenceBody,
} from './evidence.ts';
import { provenanceFromEnv } from './provenance.ts';

const OTHER_DIGEST = `sha256:${'c'.repeat(64)}`;
const PINS = { '4.3.6': DIGEST, '4.2.9': OTHER_DIGEST };
const WORKFLOW =
  'example/repo/.github/workflows/conformance-record.yml@refs/heads/main';

export const RUN_ENV = {
  GITHUB_ACTIONS: 'true',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'example/repo',
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_WORKFLOW_REF: WORKFLOW,
  DEFAULT_BRANCH: 'main',
};

const inputs = (cells = 'CF-SMOKE-01', versions = '4.3.6') =>
  parseRecordInputs(cells, versions);
const expectation = (cells?: string, versions?: string): RunExpectation =>
  expectationFromEnv(RUN_ENV, inputs(cells, versions), PINS);

describe('A-20 the inputs of the workflow', () => {
  it('accepts ids, patterns and versions, drops duplicates', () => {
    expect(
      parseRecordInputs('CF-SMOKE-01,CF-SETTLE-*,CF-SMOKE-01', '4.3.6,4.2.9'),
    ).toEqual({
      cells: ['CF-SMOKE-01', 'CF-SETTLE-*'],
      versions: ['4.3.6', '4.2.9'],
    });
  });

  it.each([
    [undefined, '4.3.6', /cells is empty/],
    ['', '4.3.6', /cells is empty/],
    ['CF-SMOKE-01', undefined, /versions is empty/],
    ['CF-SMOKE-01', '', /versions is empty/],
    ['cf-smoke-01', '4.3.6', /cells/],
    ['CF-SMOKE-01, CF-X-1', '4.3.6', /cells/],
    ['CF-SMOKE-01,,CF-X-1', '4.3.6', /cells/],
    ['CF-A;touch x', '4.3.6', /cells/],
    ['CF-$(id)', '4.3.6', /cells/],
    ['CF-A`id`', '4.3.6', /cells/],
    ['CF-A\nCF-B', '4.3.6', /cells/],
    ['CF-A"', '4.3.6', /cells/],
    ['*', '4.3.6', /cells/],
    [
      Array.from({ length: 21 }, (_, i) => `CF-X-${String(i)}`).join(','),
      '4.3.6',
      /more than 20/,
    ],
    ['CF-SMOKE-01', '4.3', /versions/],
    ['CF-SMOKE-01', '4.3.6 ', /versions/],
    ['CF-SMOKE-01', 'latest', /versions/],
    ['CF-SMOKE-01', '4.3.6;x', /versions/],
    ['CF-SMOKE-01', '4.3.6\n4.2.9', /versions/],
    ['CF-SMOKE-01', '4.3.6,', /versions/],
    [
      'CF-SMOKE-01',
      '1.0.0,1.0.1,1.0.2,1.0.3,1.0.4,1.0.5,1.0.6,1.0.7,1.0.8',
      /more than 8/,
    ],
  ])('refuses cells %j with versions %j', (cells, versions, reason) => {
    expect(() => parseRecordInputs(cells, versions)).toThrow(reason);
    expect(() => parseRecordInputs(cells, versions)).toThrow(BundleError);
  });
});

describe('A-20 the stamp this run must have made', () => {
  it('is built from the GitHub variables and equals what the recorder stamps', () => {
    const expected = expectation();
    const stamp = provenanceFromEnv(RUN_ENV);
    expect(stamp).toMatchObject({
      kind: 'ci',
      gitSha: expected.gitSha,
      runUrl: expected.runUrl,
      workflow: expected.workflowRef,
    });
    expect(expected.pins).toEqual(PINS);
  });

  it.each([
    ['outside GitHub Actions', { GITHUB_ACTIONS: undefined }],
    [
      'another workflow',
      {
        GITHUB_WORKFLOW_REF:
          'example/repo/.github/workflows/ci.yml@refs/heads/main',
      },
    ],
    [
      'another repository',
      {
        GITHUB_WORKFLOW_REF:
          'evil/repo/.github/workflows/conformance-record.yml@refs/heads/main',
      },
    ],
    [
      'another branch',
      {
        GITHUB_WORKFLOW_REF:
          'example/repo/.github/workflows/conformance-record.yml@refs/heads/feature',
      },
    ],
    [
      'a pull request ref',
      {
        GITHUB_WORKFLOW_REF:
          'example/repo/.github/workflows/conformance-record.yml@refs/pull/1/merge',
      },
    ],
    [
      'a nested workflow path',
      {
        GITHUB_WORKFLOW_REF:
          'example/repo/.github/workflows/x/conformance-record.yml@refs/heads/main',
      },
    ],
    ['a short sha', { GITHUB_SHA: 'abc' }],
    ['no sha', { GITHUB_SHA: undefined }],
    ['no attempt', { GITHUB_RUN_ATTEMPT: undefined }],
    ['a run id with text', { GITHUB_RUN_ID: '1/../2' }],
    ['plain http', { GITHUB_SERVER_URL: 'http://github.com' }],
    [
      'a server url with a login',
      { GITHUB_SERVER_URL: 'https://u@github.com' },
    ],
    ['no default branch', { DEFAULT_BRANCH: undefined }],
    ['a default branch with a space', { DEFAULT_BRANCH: 'ma in' }],
    [
      'a default branch that is shell code, even when the workflow ref says the same',
      {
        DEFAULT_BRANCH: 'main;id',
        GITHUB_WORKFLOW_REF:
          'example/repo/.github/workflows/conformance-record.yml@refs/heads/main;id',
      },
    ],
    ['a malformed repository', { GITHUB_REPOSITORY: 'example' }],
  ])('refuses %s', (_name, change) => {
    expect(() =>
      expectationFromEnv({ ...RUN_ENV, ...change }, inputs(), PINS),
    ).toThrow(BundleError);
  });

  it('accepts another default branch when the workflow ref is on it', () => {
    const expected = expectationFromEnv(
      {
        ...RUN_ENV,
        DEFAULT_BRANCH: 'trunk',
        GITHUB_WORKFLOW_REF:
          'example/repo/.github/workflows/conformance-record.yml@refs/heads/trunk',
      },
      inputs(),
      PINS,
    );
    expect(expected.workflowRef).toMatch(/@refs\/heads\/trunk$/);
  });
});

describe('A-20 the evidence bundle of a run', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bundle-spec-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const put = (
    version: string,
    cfId: string,
    change: (body: EvidenceBody) => EvidenceBody = (body) => body,
  ): string => {
    const artefact = sealArtefact(
      evidenceBody((body) =>
        change({
          ...body,
          cfId,
          brokerVersion: version,
          imageDigest: PINS[version as keyof typeof PINS],
        }),
      ),
    );
    mkdirSync(join(root, version), { recursive: true });
    writeFileSync(
      join(root, version, `${cfId}.json`),
      JSON.stringify(artefact),
    );
    return join(root, version, `${cfId}.json`);
  };
  const problems = (
    expected = expectation(),
    verify?: (path: string, text: string) => void,
  ) =>
    checkBundle(root, expected, verify ? { verifyText: verify } : {}).problems;

  it('passes when every artefact is this run, on the pinned image, for every cell and version', () => {
    put('4.3.6', 'CF-SMOKE-01');
    const report = checkBundle(root, expectation());
    expect(report.problems).toEqual([]);
    expect(report.files).toEqual([
      expect.objectContaining({
        path: '4.3.6/CF-SMOKE-01.json',
        cfId: 'CF-SMOKE-01',
        brokerVersion: '4.3.6',
        imageDigest: DIGEST,
      }),
    ]);
  });

  it('passes a pattern over several cells and versions, and runs the full verification on each file', () => {
    for (const version of ['4.3.6', '4.2.9']) {
      put(version, 'CF-SETTLE-01');
      put(version, 'CF-SETTLE-02');
    }
    const seen: string[] = [];
    const found = problems(
      expectation('CF-SETTLE-*', '4.3.6,4.2.9'),
      (path, text) => {
        seen.push(path);
        verifyEvidenceText(path, text);
      },
    );
    expect(found).toEqual([]);
    expect(seen.sort()).toEqual([
      '4.2.9/CF-SETTLE-01.json',
      '4.2.9/CF-SETTLE-02.json',
      '4.3.6/CF-SETTLE-01.json',
      '4.3.6/CF-SETTLE-02.json',
    ]);
  });

  it('AC-1 an artefact without CI provenance is refused, even sealed and well formed', () => {
    put('4.3.6', 'CF-SMOKE-01', (body) => ({
      ...body,
      provenance: localProvenance,
    }));
    const report = checkBundle(root, expectation());
    expect(report.problems).toEqual([
      '4.3.6/CF-SMOKE-01.json has no CI provenance',
    ]);
    expect(report.files).toEqual([]);
  });

  it.each([
    [
      'another commit',
      { gitSha: 'b'.repeat(40) },
      'was recorded at another commit',
    ],
    [
      'another run',
      { runUrl: 'https://github.com/example/repo/actions/runs/999/attempts/1' },
      'was recorded by another run',
    ],
    [
      'another attempt of the run',
      { runUrl: 'https://github.com/example/repo/actions/runs/123/attempts/2' },
      'was recorded by another run',
    ],
    [
      'another workflow',
      { workflow: 'example/repo/.github/workflows/ci.yml@refs/heads/main' },
      'was recorded by another workflow',
    ],
    [
      'another branch',
      {
        workflow:
          'example/repo/.github/workflows/conformance-record.yml@refs/heads/feature',
      },
      'was recorded by another workflow',
    ],
  ])('refuses a ci stamp of %s', (_name, change, reason) => {
    put('4.3.6', 'CF-SMOKE-01', (body) => ({
      ...body,
      provenance: { ...body.provenance, ...change },
    }));
    expect(problems()).toEqual([`4.3.6/CF-SMOKE-01.json ${reason}`]);
  });

  it('refuses an artefact with no provenance, a provenance that is not an object, or another recorder', () => {
    const path = put('4.3.6', 'CF-SMOKE-01');
    const sealed = JSON.parse(
      JSON.stringify(sealArtefact(evidenceBody())),
    ) as Record<string, unknown>;
    const rewrite = (change: (value: Record<string, unknown>) => void) => {
      const value = { ...sealed };
      change(value);
      writeFileSync(path, JSON.stringify(value));
    };
    rewrite((value) => {
      delete value.provenance;
    });
    expect(problems()).toEqual(['4.3.6/CF-SMOKE-01.json has no CI provenance']);
    rewrite((value) => {
      value.provenance = 'ci';
    });
    expect(problems()).toEqual(['4.3.6/CF-SMOKE-01.json has no CI provenance']);
    rewrite((value) => {
      value.provenance = {
        ...(sealed.provenance as Record<string, unknown>),
        recorder: 'by-hand',
      };
    });
    expect(problems()).toEqual([
      '4.3.6/CF-SMOKE-01.json was recorded by another recorder',
    ]);
  });

  it('refuses an artefact recorded on an image that is not the pin of its version', () => {
    put('4.3.6', 'CF-SMOKE-01', (body) => ({
      ...body,
      imageDigest: OTHER_DIGEST,
    }));
    expect(problems()).toEqual([
      '4.3.6/CF-SMOKE-01.json was not recorded on the digest-pinned image of 4.3.6',
    ]);
  });

  it('refuses a version with no pin at all', () => {
    put('4.3.6', 'CF-SMOKE-01');
    expect(checkBundle(root, { ...expectation(), pins: {} }).problems).toEqual([
      '4.3.6/CF-SMOKE-01.json was not recorded on the digest-pinned image of 4.3.6',
    ]);
  });

  it('refuses a file that holds another cell or another version than its path says', () => {
    put('4.3.6', 'CF-SMOKE-01', (body) => ({ ...body, cfId: 'CF-OTHER-01' }));
    expect(problems()).toContain(
      '4.3.6/CF-SMOKE-01.json holds the evidence of another cell',
    );
    const wrongVersion = put('4.2.9', 'CF-SMOKE-01');
    writeFileSync(
      wrongVersion,
      JSON.stringify(
        sealArtefact(
          evidenceBody((body) => ({
            ...body,
            brokerVersion: '4.3.6',
          })),
        ),
      ),
    );
    expect(problems(expectation('CF-SMOKE-01', '4.3.6,4.2.9'))).toContain(
      '4.2.9/CF-SMOKE-01.json holds the evidence of another broker version',
    );
  });

  it('refuses a bundle that misses a cell or a version that was asked for', () => {
    put('4.3.6', 'CF-SMOKE-01');
    expect(problems(expectation('CF-SMOKE-01', '4.3.6,4.2.9'))).toEqual([
      'CF-SMOKE-01 has no artefact for 4.2.9',
    ]);
    expect(problems(expectation('CF-SMOKE-01,CF-SETTLE-*'))).toEqual([
      'CF-SETTLE-* has no artefact for 4.3.6',
    ]);
  });

  it('refuses an empty bundle, a missing folder and a folder that is a file', () => {
    expect(problems()).toEqual(['CF-SMOKE-01 has no artefact for 4.3.6']);
    expect(checkBundle(join(root, 'nope'), expectation()).problems).toEqual([
      'the bundle folder does not exist',
    ]);
    writeFileSync(join(root, 'file'), 'x');
    expect(checkBundle(join(root, 'file'), expectation()).problems).toEqual([
      'the bundle folder does not exist',
    ]);
  });

  it('refuses anything in the bundle that is not an artefact of a requested cell and version', () => {
    put('4.3.6', 'CF-SMOKE-01');
    put('4.2.9', 'CF-SMOKE-01');
    writeFileSync(join(root, 'notes.txt'), 'x');
    writeFileSync(join(root, '4.3.6', 'README.md'), 'x');
    writeFileSync(join(root, '4.3.6', 'cf-smoke-02.json'), '{}');
    mkdirSync(join(root, '4.3.6', 'CF-SMOKE-03.json'));
    mkdirSync(join(root, 'latest'));
    put('4.3.6', 'CF-OTHER-01');
    const found = problems();
    expect(found).toEqual(
      expect.arrayContaining([
        'notes.txt is not a folder',
        '4.3.6/README.md is not named <CF-id>.json',
        '4.3.6/cf-smoke-02.json is not named <CF-id>.json',
        '4.3.6/CF-SMOKE-03.json is not a regular file',
        'latest/ is not a requested broker version',
        '4.2.9/ is not a requested broker version',
        '4.3.6/CF-OTHER-01.json is not one of the requested cells',
      ]),
    );
  });

  it('refuses a symbolic link in place of an artefact', () => {
    const real = put('4.3.6', 'CF-SMOKE-01');
    try {
      symlinkSync(real, join(root, '4.3.6', 'CF-SMOKE-02.json'));
    } catch {
      return; // creating links needs a privilege on some Windows setups
    }
    expect(problems(expectation('CF-SMOKE-*'))).toEqual([
      '4.3.6/CF-SMOKE-02.json is not a regular file',
    ]);
  });

  it('refuses an oversize file, text that is not JSON and JSON that is not an object', () => {
    put('4.3.6', 'CF-SMOKE-01');
    const big = put('4.3.6', 'CF-SMOKE-02');
    writeFileSync(big, 'x'.repeat(MAX_ARTEFACT_BYTES + 1));
    writeFileSync(join(root, '4.3.6', 'CF-SMOKE-03.json'), 'not json');
    writeFileSync(join(root, '4.3.6', 'CF-SMOKE-04.json'), '[1]');
    expect(problems(expectation('CF-SMOKE-*'))).toEqual([
      expect.stringMatching(/CF-SMOKE-02\.json is larger than/),
      '4.3.6/CF-SMOKE-03.json is not valid JSON',
      '4.3.6/CF-SMOKE-04.json is not an object',
    ]);
  });

  it('does not call a file of exactly the largest size too large', () => {
    put('4.3.6', 'CF-SMOKE-01');
    writeFileSync(
      join(root, '4.3.6', 'CF-SMOKE-02.json'),
      ' '.repeat(MAX_ARTEFACT_BYTES),
    );
    expect(problems(expectation('CF-SMOKE-*'))).toEqual([
      '4.3.6/CF-SMOKE-02.json is not valid JSON',
    ]);
  });

  it('refuses more artefacts than a run can make', () => {
    for (let index = 0; index <= MAX_ARTEFACTS; index += 1) {
      put('4.3.6', `CF-BULK-${String(index).padStart(3, '0')}`);
    }
    expect(problems(expectation('CF-BULK-*'))).toEqual(
      expect.arrayContaining([`more than ${String(MAX_ARTEFACTS)} artefacts`]),
    );
  });

  it('refuses an artefact the full verification refuses, and one with no integrity digest', () => {
    const path = put('4.3.6', 'CF-SMOKE-01');
    const text = JSON.stringify({
      ...JSON.parse(
        JSON.stringify(
          sealArtefact(
            evidenceBody((body) => ({
              ...body,
              imageDigest: DIGEST,
            })),
          ),
        ),
      ),
      title: 'edited by hand',
    });
    writeFileSync(path, text);
    expect(problems(expectation(), verifyEvidenceText)).toEqual([
      expect.stringMatching(
        /^4\.3\.6\/CF-SMOKE-01\.json does not verify: the integrity digest/,
      ),
    ]);
    const rest = JSON.parse(text) as Record<string, unknown>;
    delete rest.integrity;
    writeFileSync(path, JSON.stringify(rest));
    expect(problems()).toEqual([
      '4.3.6/CF-SMOKE-01.json has no integrity digest',
    ]);
  });

  it('reports at most fifty problems', () => {
    for (let index = 0; index < 60; index += 1) {
      writeFileSync(join(root, `file-${String(index)}`), 'x');
    }
    expect(problems().length).toBe(50);
  });

  it('AC-2 the pull request description names the run, the commit and every artefact with its digests, and nothing the artefacts say about themselves', () => {
    put('4.3.6', 'CF-SMOKE-01', (body) => ({
      ...body,
      title: 'Free text <script>alert(1)</script> $(id)',
    }));
    const expected = expectation();
    const report = checkBundle(root, expected);
    const body = renderPrBody(expected, report.files);
    expect(body).toContain(
      'https://github.com/example/repo/actions/runs/123/attempts/1',
    );
    expect(body).toContain('a'.repeat(40));
    expect(body).toContain('`testing/lab-evidence/4.3.6/CF-SMOKE-01.json`');
    expect(body).toContain(DIGEST);
    expect(body).toContain(report.files[0]?.integrityDigest);
    expect(body).toContain('Nothing here is merged or approved automatically');
    expect(body).not.toContain('script');
    expect(body).not.toContain('$(id)');
  });
});
