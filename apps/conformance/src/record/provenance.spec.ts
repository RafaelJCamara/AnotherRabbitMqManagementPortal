import { describe, expect, it } from 'vitest';

import { EvidenceError } from './evidence.ts';
import { provenanceFromEnv } from './provenance.ts';

const SHA = 'f'.repeat(40);
const NOW = new Date('2026-10-19T12:00:00.000Z');
const WORKFLOW =
  'example/repo/.github/workflows/conformance-record.yml@refs/heads/main';

const ci = {
  GITHUB_ACTIONS: 'true',
  GITHUB_WORKFLOW_REF: WORKFLOW,
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'example/repo',
  GITHUB_RUN_ID: '42',
  GITHUB_RUN_ATTEMPT: '2',
  GITHUB_SHA: SHA,
};

describe('A-20 the provenance stamp', () => {
  it('only the conformance-record workflow makes a ci stamp, with commit, run URL and workflow', () => {
    expect(provenanceFromEnv(ci, NOW)).toEqual({
      kind: 'ci',
      recorder: 'conformance:record',
      gitSha: SHA,
      runUrl: 'https://github.com/example/repo/actions/runs/42/attempts/2',
      workflow: WORKFLOW,
      recordedAt: '2026-10-19T12:00:00.000Z',
    });
  });

  it('leaves out the attempt when the service does not name one', () => {
    expect(
      provenanceFromEnv({ ...ci, GITHUB_RUN_ATTEMPT: undefined }, NOW),
    ).toMatchObject({
      runUrl: 'https://github.com/example/repo/actions/runs/42',
    });
  });

  it.each([
    ['a developer machine', {}],
    [
      'another workflow of the same CI service',
      {
        ...ci,
        GITHUB_WORKFLOW_REF:
          'example/repo/.github/workflows/ci.yml@refs/heads/main',
      },
    ],
    [
      'a workflow whose name only ends like the record workflow',
      {
        ...ci,
        GITHUB_WORKFLOW_REF:
          'example/repo/.github/workflows/my-conformance-record.yml@refs/heads/main',
      },
    ],
    [
      'GITHUB_ACTIONS unset, everything else set',
      { ...ci, GITHUB_ACTIONS: undefined },
    ],
    ['GITHUB_ACTIONS false', { ...ci, GITHUB_ACTIONS: 'false' }],
    [
      'a workflow file of that name nested elsewhere in the path',
      {
        ...ci,
        GITHUB_WORKFLOW_REF:
          'a/b/c/.github/workflows/conformance-record.yml@refs/heads/main',
      },
    ],
    ['no workflow reference', { ...ci, GITHUB_WORKFLOW_REF: undefined }],
  ])('%s makes a local stamp', (_name, env) => {
    expect(provenanceFromEnv(env, NOW)).toMatchObject({ kind: 'local' });
  });

  it('a local stamp keeps a valid commit, and drops anything else', () => {
    expect(provenanceFromEnv({ GITHUB_SHA: SHA }, NOW)).toMatchObject({
      gitSha: SHA,
    });
    expect(provenanceFromEnv({ GITHUB_SHA: 'main' }, NOW)).toMatchObject({
      gitSha: null,
    });
    expect(provenanceFromEnv({}, NOW)).toMatchObject({ gitSha: null });
  });

  it.each([
    'GITHUB_SERVER_URL',
    'GITHUB_REPOSITORY',
    'GITHUB_RUN_ID',
    'GITHUB_SHA',
  ])(
    'the record workflow without %s is an error, not a quiet local stamp',
    (name) => {
      expect(() =>
        provenanceFromEnv({ ...ci, [name]: undefined }, NOW),
      ).toThrow(EvidenceError);
    },
  );

  it('uses the clock it is given', () => {
    expect(
      provenanceFromEnv({}, new Date('2030-01-02T03:04:05.000Z')).recordedAt,
    ).toBe('2030-01-02T03:04:05.000Z');
  });
});
