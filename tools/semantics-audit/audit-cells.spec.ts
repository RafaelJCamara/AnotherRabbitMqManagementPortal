// End-to-end proof of the audit-cells target: the real CLI against fixture data and the shipped data.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = join(import.meta.dirname, 'audit-cells.ts');
const register = pathToFileURL(join(import.meta.dirname, 'register.mjs')).href;
const repo = join(import.meta.dirname, '..', '..');

function run(...args: string[]) {
  return spawnSync(process.execPath, ['--import', register, script, ...args], {
    encoding: 'utf8',
    cwd: repo,
  });
}

const fixture = (name: string): string =>
  `--data=${join(import.meta.dirname, 'fixtures', name)}`;

describe('audit-cells', () => {
  it('passes on the data this release ships', () => {
    const result = run();

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('cell(s) pass');
  });

  it('passes a complete cell and a generated stub when only conformance is required', () => {
    const result = run(fixture('sample.ts'));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('2 cell(s) pass');
  });

  it('fails a cell without a conformance id and a duplicate cell', () => {
    const result = run(fixture('no-conformance.ts'));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('names no conformance id');
    expect(result.stderr).toContain('used by 2 cells');
  });

  it('fails the stub when citations and a derived effect are required', () => {
    const result = run(
      fixture('sample.ts'),
      '--require=citations,conformance,effect',
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'SEM-4.3-quorum-amqp091-amqp091.reject_requeue: has no citation',
    );
    expect(result.stderr).toContain('has no derived effect yet');
    expect(result.stderr).not.toContain(
      'SEM-4.3-quorum-amqp091-amqp091.nack_requeue',
    );
  });

  it('fails a lab-verified cell whose evidence file does not exist', () => {
    const result = run(fixture('verified-without-file.ts'));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'testing/lab-evidence/4.3.6/CF-SAMPLE-01.json does not exist',
    );
  });

  it('rejects a requirement it does not know and a data module without registryData', () => {
    const unknown = run('--require=speed');
    const missing = run(`--data=${join(import.meta.dirname, 'package.json')}`);

    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('unknown requirement speed');
    expect(missing.status).toBe(1);
  });
});
