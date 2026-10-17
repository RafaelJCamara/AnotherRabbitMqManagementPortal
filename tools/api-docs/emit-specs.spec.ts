// End-to-end proof of the drift gate: the real CLI against a temporary output directory.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = join(import.meta.dirname, 'emit-specs.ts');
const register = pathToFileURL(join(import.meta.dirname, 'register.mjs')).href;

function run(...args: string[]) {
  return spawnSync(process.execPath, ['--import', register, script, ...args], {
    encoding: 'utf8',
  });
}

const tempDir = () => mkdtempSync(join(tmpdir(), 'api-docs-'));
const readJson = (path: string) =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

describe('emit-specs', () => {
  it('AC-2 writes both specs, and --check passes on a fresh output', () => {
    const out = tempDir();
    expect(run(`--out=${out}`).status).toBe(0);
    expect(readJson(join(out, 'openapi.v1.json')).openapi).toBe('3.1.0');
    expect(readJson(join(out, 'asyncapi.v1.json')).asyncapi).toBe('3.0.0');
    expect(run('--check', `--out=${out}`).status).toBe(0);
  });

  it('AC-2 --check fails on a stale or missing spec', () => {
    const out = tempDir();
    expect(run(`--out=${out}`).status).toBe(0);
    writeFileSync(join(out, 'openapi.v1.json'), '{}\n');
    const stale = run('--check', `--out=${out}`);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toMatch(/openapi\.v1\.json/);
    expect(stale.stderr).toMatch(/contracts:api-docs/);

    expect(run('--check', `--out=${tempDir()}`).status).toBe(1);
  });

  it('AC-2 the committed docs/api specs are current', () => {
    const repo = join(import.meta.dirname, '..', '..');
    const result = run('--check', `--out=${join(repo, 'docs', 'api')}`);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
