import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AppError } from '@app/kernel';
import { SchemaTooNewError } from '@app/persistence';
import { SecretsError } from '@app/secrets';
import { describe, expect, it } from 'vitest';

import { DataDirLockedError } from '../data-dir-lock.ts';
import { ModeRefusedError } from '../modes/types.ts';
import { UsageError } from './args.ts';
import { describeFailure, drainBudgetMs, EXIT } from './main.ts';
import { ENGINE_VERSION } from './version.ts';

const src = fileURLToPath(new URL('..', import.meta.url));
const root = fileURLToPath(new URL('../../../../', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : [path];
  });
}

describe('how a failed start is reported', () => {
  it('maps each refusal to its own exit code and a reason on one JSON line', () => {
    expect(describeFailure(new UsageError('bad flag'))).toEqual({
      exitCode: EXIT.usage,
      line: {
        event: 'engine.start.failed',
        reason: 'usage',
        detail: 'bad flag',
      },
    });
    expect(describeFailure(new DataDirLockedError('in use', 4321))).toEqual({
      exitCode: EXIT.locked,
      line: {
        event: 'engine.start.failed',
        reason: 'data-dir-locked',
        detail: 'in use',
        holderPid: 4321,
      },
    });
    expect(describeFailure(new ModeRefusedError('later')).line).toMatchObject({
      reason: 'mode-unavailable',
    });
    expect(describeFailure(new ModeRefusedError('later')).exitCode).toBe(
      EXIT.refused,
    );
    const newer = describeFailure(new SchemaTooNewError(9, 5));
    expect(newer.exitCode).toBe(EXIT.refused);
    expect(newer.line).toMatchObject({
      reason: 'schema-too-new',
      problem: { code: 'INTERNAL' },
    });
  });

  it('reports a vault refusal by its code, which says little by design', () => {
    const failure = describeFailure(
      new SecretsError('KEK_MISMATCH', 'the KEK does not open the stored key'),
    );

    expect(failure.exitCode).toBe(EXIT.refused);
    expect(failure.line).toEqual({
      event: 'engine.start.failed',
      reason: 'vault',
      code: 'KEK_MISMATCH',
      detail: 'the KEK does not open the stored key',
    });
  });

  it('reports an unknown error by its Problem code and never by its message or stack (I-10)', () => {
    const failure = describeFailure(
      new Error('connect failed for amqp://user:hunter2@broker/'),
    );

    expect(failure.exitCode).toBe(EXIT.failure);
    expect(failure.line).toMatchObject({
      reason: 'failed',
      problem: { code: 'INTERNAL' },
    });
    expect(JSON.stringify(failure.line)).not.toContain('hunter2');
    expect(JSON.stringify(failure.line)).not.toContain('at ');
    expect(describeFailure(new AppError('GATE_BLOCKED')).line).toMatchObject({
      problem: { code: 'GATE_BLOCKED' },
    });
  });

  it('keeps the exit codes distinct', () => {
    expect(new Set(Object.values(EXIT)).size).toBe(Object.keys(EXIT).length);
    expect(EXIT.ok).toBe(0);
  });
});

describe('the drain budget of a ctl:shutdown', () => {
  it('is what main asked for, within 1 ms and 30 s, so a huge number cannot overflow a timer', () => {
    expect(drainBudgetMs(2000)).toBe(2000);
    expect(drainBudgetMs(1)).toBe(1);
    expect(drainBudgetMs(0)).toBe(1);
    expect(drainBudgetMs(-5)).toBe(1);
    expect(drainBudgetMs(30_000)).toBe(30_000);
    expect(drainBudgetMs(30_001)).toBe(30_000);
    expect(drainBudgetMs(2 ** 40)).toBe(30_000);
  });
});

describe('mode logic stays in the mode files (ADR-001)', () => {
  it('AC-2 no file outside entry/, modes/ and modules/ names a delivery mode as a value', () => {
    const exempt = ['entry', 'modes', 'modules', 'testing'].map(
      (name) => `${join(src, name)}${sep}`,
    );
    const offenders = sources(src)
      .filter((path) => path.endsWith('.ts') && !path.endsWith('.spec.ts'))
      .filter((path) => !exempt.some((prefix) => path.startsWith(prefix)))
      .filter((path) =>
        // M0-59 AC-13: the container runtime is a mode-file concern too.
        /['"`](?:desktop|local|team|container|native)['"`]/.test(
          readFileSync(path, 'utf8'),
        ),
      )
      .map((path) => relative(src, path));

    expect(offenders).toEqual([]);
  });

  it('AC-2 the composition root takes the mode from its profile and compares it with nothing', () => {
    const core = readFileSync(join(src, 'compose-core.ts'), 'utf8');

    expect(core).not.toMatch(/\bmode\s*[!=]==?/);
    expect(core).not.toMatch(/switch\s*\(\s*\w*\.?mode/);
  });
});

describe('the engine version', () => {
  it('is the workspace version, which release-please keeps in step', () => {
    const workspace = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    ) as { version: string };

    expect(ENGINE_VERSION).toBe(workspace.version);
  });

  it('is listed among the files release-please bumps', () => {
    const config = readFileSync(
      join(root, 'release-please-config.json'),
      'utf8',
    );

    expect(config).toContain('apps/engine/src/entry/version.ts');
    expect(readFileSync(join(src, 'entry', 'version.ts'), 'utf8')).toContain(
      'x-release-please-version',
    );
  });
});
