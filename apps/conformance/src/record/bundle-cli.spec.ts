import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DIGEST, evidenceBody } from '../testing/lab.ts';
import { main, readPins, type CliIo } from './bundle-cli.ts';
import { sealArtefact } from './evidence.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CLI = join(HERE, 'bundle-cli.ts');
const REAL_PINS = fileURLToPath(
  new URL('../../../../testing/broker-lab/versions.json', import.meta.url),
);
const WORKFLOW =
  'example/repo/.github/workflows/conformance-record.yml@refs/heads/main';
const ENV = {
  GITHUB_ACTIONS: 'true',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'example/repo',
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_WORKFLOW_REF: WORKFLOW,
  DEFAULT_BRANCH: 'main',
  CELLS: 'CF-SMOKE-01',
  VERSIONS: '4.3.6',
};

describe('A-20 the checks of the write job', () => {
  let root: string;
  let out: string[];
  let err: string[];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bundle-cli-'));
    out = [];
    err = [];
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const writeBundle = (text?: string): string => {
    const dir = join(root, 'bundle');
    mkdirSync(join(dir, '4.3.6'), { recursive: true });
    writeFileSync(
      join(dir, '4.3.6', 'CF-SMOKE-01.json'),
      text ?? JSON.stringify(sealArtefact(evidenceBody())),
    );
    return dir;
  };

  it('reads the pins of testing/broker-lab/versions.json: one sha256 digest per lab version', () => {
    const pins = readPins(REAL_PINS);
    expect(Object.keys(pins)).toEqual(
      expect.arrayContaining(['3.13.7', '4.0.9', '4.1.8', '4.2.9', '4.3.6']),
    );
    for (const digest of Object.values(pins)) {
      expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    expect(pins['4.3.6']).toBe(DIGEST);
  });

  it('validate-inputs passes good inputs and refuses bad ones', async () => {
    expect(await main(['validate-inputs'], ENV, io)).toBe(0);
    expect(out).toEqual(['cells: CF-SMOKE-01; versions: 4.3.6']);
    expect(
      await main(['validate-inputs'], { ...ENV, CELLS: 'CF-A;id' }, io),
    ).toBe(1);
    expect(err[0]).toMatch(/^refused: cells:/);
    expect(await main(['validate-inputs', '--x=1'], ENV, io)).toBe(1);
    expect(await main([], ENV, io)).toBe(1);
    expect(await main(['record'], ENV, io)).toBe(1);
  });

  it('check passes a bundle of this run against the real pins, and writes the description only then', async () => {
    const dir = writeBundle();
    const description = join(root, 'pr-body.md');
    expect(
      await main(
        ['check', `--dir=${dir}`, `--pr-body=${description}`],
        ENV,
        io,
      ),
    ).toBe(0);
    expect(out).toEqual([
      '1 artefacts match run https://github.com/example/repo/actions/runs/123/attempts/1',
    ]);
    expect(readFileSync(description, 'utf8')).toContain(
      '`testing/lab-evidence/4.3.6/CF-SMOKE-01.json`',
    );
  });

  it('check also verifies the integrity digest with --integrity', async () => {
    const sealed = sealArtefact(evidenceBody());
    const dir = writeBundle(JSON.stringify({ ...sealed, title: 'edited' }));
    expect(await main(['check', `--dir=${dir}`], ENV, io)).toBe(0);
    expect(await main(['check', `--dir=${dir}`, '--integrity'], ENV, io)).toBe(
      1,
    );
    expect(err.join('\n')).toMatch(/does not verify: the integrity digest/);
  });

  it('check refuses a bundle that is not this run and writes no description', async () => {
    const dir = writeBundle();
    const description = join(root, 'pr-body.md');
    expect(
      await main(
        ['check', `--dir=${dir}`, `--pr-body=${description}`],
        { ...ENV, GITHUB_SHA: 'b'.repeat(40) },
        io,
      ),
    ).toBe(1);
    expect(err).toEqual([
      'refused: 4.3.6/CF-SMOKE-01.json was recorded at another commit',
    ]);
    expect(existsSync(description)).toBe(false);
  });

  it('check refuses a missing or unknown option even for a good bundle', async () => {
    const dir = writeBundle();
    expect(await main(['check', `--dir=${dir}`], ENV, io)).toBe(0);
    for (const extra of [
      '--unknown',
      '--pr-body=',
      '--integrity=yes',
      '--dir=',
    ]) {
      err.length = 0;
      expect(await main(['check', `--dir=${dir}`, extra], ENV, io)).toBe(1);
      expect(err).toEqual([`refused: unknown option ${extra}`]);
    }
    err.length = 0;
    expect(await main(['check'], ENV, io)).toBe(1);
    expect(err).toEqual(['refused: --dir=<bundle> is required']);
  });

  it('check refuses to run outside GitHub Actions or for another workflow', async () => {
    const dir = writeBundle();
    expect(
      await main(
        ['check', `--dir=${dir}`],
        { ...ENV, GITHUB_ACTIONS: undefined },
        io,
      ),
    ).toBe(1);
    expect(
      await main(
        ['check', `--dir=${dir}`],
        {
          ...ENV,
          GITHUB_WORKFLOW_REF:
            'example/repo/.github/workflows/ci.yml@refs/heads/main',
        },
        io,
      ),
    ).toBe(1);
  });

  it('runs as a script and exits with the code of main', () => {
    const run = (env: Record<string, string>) =>
      spawnSync(process.execPath, [CLI, 'validate-inputs'], {
        cwd: root,
        env: { PATH: process.env.PATH ?? '', ...env },
        encoding: 'utf8',
      });
    expect(run(ENV).status).toBe(0);
    const bad = run({ ...ENV, VERSIONS: 'latest' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('refused: versions:');
  });
});

describe('A-20 the write job installs nothing', () => {
  const importsOf = (file: string): string[] =>
    [
      ...readFileSync(join(HERE, file), 'utf8').matchAll(
        /^(?:import|export)\s[^;]*?from\s+'([^']+)'/gms,
      ),
    ].map((match) => match[1] ?? '');

  it('bundle.ts and bundle-cli.ts statically import only Node built-ins and each other', () => {
    expect(importsOf('bundle.ts').sort()).toEqual(['node:fs', 'node:path']);
    expect(importsOf('bundle-cli.ts').sort()).toEqual([
      './bundle.ts',
      'node:fs',
      'node:path',
      'node:url',
    ]);
  });

  it('the integrity check is loaded only on request', () => {
    const source = readFileSync(CLI, 'utf8');
    expect(source).toMatch(/await import\('\.\/evidence\.ts'\)/);
    expect(source).not.toMatch(/from '\.\/evidence\.ts'/);
  });
});
