import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONTAINER,
  MemoryHost,
  brokerData,
  containerShape,
  fakeDocker,
  pinned,
} from '../testing/lab.ts';
import { CANONICAL_ROOT, chooseRoot, main, parseArgs } from './cli.ts';
import { verifyEvidenceText } from './evidence.ts';
import { provenanceFromEnv } from './provenance.ts';

describe('conformance:record command line', () => {
  it('reads --cells (comma separated) and --out', () => {
    expect(
      parseArgs(['--cells=CF-SMOKE-01,CF-SETTLE-*', '--out=/tmp/x']),
    ).toEqual({
      cells: ['CF-SMOKE-01', 'CF-SETTLE-*'],
      out: '/tmp/x',
    });
    expect(parseArgs(['--cells=CF-SMOKE-01'])).toEqual({
      cells: ['CF-SMOKE-01'],
      out: undefined,
    });
  });

  it.each([
    [[], /--cells/],
    [['--cells='], /Unknown argument/],
    [['--cells=,'], /--cells/],
    [['--versions=4.3.6', '--cells=CF-SMOKE-01'], /Unknown argument/],
    [['--cell=CF-SMOKE-01'], /Unknown argument/],
    [['CF-SMOKE-01'], /Unknown argument/],
    [['--out=x'], /--cells/],
  ])('refuses %j', (argv, reason) => {
    expect(() => parseArgs(argv)).toThrow(reason);
  });
});

describe('where the artefacts go', () => {
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_WORKFLOW_REF:
      'o/r/.github/workflows/conformance-record.yml@refs/heads/main',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_RUN_ID: '1',
    GITHUB_SHA: 'a'.repeat(40),
  };

  it('the evidence tree is testing/lab-evidence of this repository', () => {
    expect(CANONICAL_ROOT.split(sep).slice(-2)).toEqual([
      'testing',
      'lab-evidence',
    ]);
  });

  it('a ci run records into the evidence tree unless told otherwise', () => {
    expect(chooseRoot(undefined, provenanceFromEnv(env))).toBe(CANONICAL_ROOT);
    expect(chooseRoot('somewhere', provenanceFromEnv(env))).toBe(
      resolve('somewhere'),
    );
  });

  it('a local run records into a fresh temporary folder unless told otherwise, never the evidence tree', () => {
    const local = provenanceFromEnv({});
    const first = chooseRoot(undefined, local);
    const second = chooseRoot(undefined, local);

    expect(first.startsWith(tmpdir())).toBe(true);
    expect(first).not.toBe(second);
    expect(first.startsWith(CANONICAL_ROOT)).toBe(false);
    expect(chooseRoot('out', local)).toBe(resolve('out'));
  });
});

describe('main', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'evidence-cli-'));
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const deps = (shape = containerShape()) => ({
    docker: fakeDocker(shape),
    pinnedDigests: pinned,
    openHost: () => Promise.resolve(new MemoryHost()),
  });
  const env = { LAB_BROKER: JSON.stringify(brokerData()) };

  it('AC-1 records CF-SMOKE-01 from LAB_BROKER and says it was a local run', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const code = await main(
      ['--cells=CF-SMOKE-01', `--out=${scratch}`],
      env,
      deps(),
    );

    expect(code).toBe(0);
    const text = readFileSync(
      join(scratch, '4.3.6', 'CF-SMOKE-01.json'),
      'utf8',
    );
    expect(
      verifyEvidenceText('4.3.6/CF-SMOKE-01.json', text).observations[0],
    ).toMatchObject({
      position: 0,
      redelivered: true,
    });
    const said = log.mock.calls.map((call) => String(call[0]));
    expect(said[0]).toContain('recorded');
    expect(
      said.some((line) =>
        line.includes('local run: the files are not lab evidence'),
      ),
    ).toBe(true);
  });

  it('never prints the lab login', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await main(['--cells=CF-SMOKE-01', `--out=${scratch}`], env, deps());

    expect(log.mock.calls.flat().join('\n')).not.toContain('guest');
  });

  it('AC-2 refuses a LAB_BROKER that broker-lab did not create, and records nothing', async () => {
    const foreign = JSON.stringify(
      brokerData({ amqp: 'amqp://127.0.0.1:5672' }),
    );

    await expect(
      main(
        ['--cells=CF-SMOKE-01', `--out=${scratch}`],
        { LAB_BROKER: foreign },
        deps(),
      ),
    ).rejects.toThrow(/AMQP port/);
    await expect(
      main(['--cells=CF-SMOKE-01', `--out=${scratch}`], {}, deps()),
    ).rejects.toThrow(/LAB_BROKER/);
    await expect(
      main(
        ['--cells=CF-SMOKE-01', `--out=${scratch}`],
        env,
        deps(
          containerShape((shape) => {
            shape.Name = `/${CONTAINER}-other`;
          }),
        ),
      ),
    ).rejects.toThrow(/name differs/);
    expect(() =>
      readFileSync(join(scratch, '4.3.6', 'CF-SMOKE-01.json')),
    ).toThrow();
  });

  it('refuses a cell that has no scenario before it touches the broker', async () => {
    let opened = false;

    await expect(
      main(['--cells=CF-NOPE-01', `--out=${scratch}`], env, {
        ...deps(),
        openHost: () => {
          opened = true;
          return Promise.resolve(new MemoryHost());
        },
      }),
    ).rejects.toThrow(/no scenario matches/);
    expect(opened).toBe(false);
  });
});
