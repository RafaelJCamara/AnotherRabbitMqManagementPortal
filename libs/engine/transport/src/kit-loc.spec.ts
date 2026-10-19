// The kit-size gate of ADR-004, run the way `nx run transport:kit-loc` runs it.
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createHarness } from './testing/harness.test.ts';

const SCRIPT = fileURLToPath(
  new URL('../scripts/kit-loc.mjs', import.meta.url),
);

function run(...args: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
  });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

describe('no new listeners (I-1, security rules)', () => {
  it('AC-2 hardening: the kit binds nothing; the composition root owns the listener', async () => {
    const app = createHarness().app;
    await app.ready();
    expect(app.server.listening).toBe(false);
    await app.close();
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const kit = readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter(
        (file) =>
          file.endsWith('.ts') &&
          !file.endsWith('.spec.ts') &&
          !file.startsWith('testing'),
      )
      .map((file) => ({
        file: file.replaceAll('\\', '/'),
        source: readFileSync(join(dir, file), 'utf8'),
      }));
    const offenders = kit
      .filter(({ source }) =>
        /\.listen\(|createServer\(|from 'node:dgram'|from 'node:http2'/.test(
          source,
        ),
      )
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
    // M0-33: `ws` belongs to the live upgrade alone, with noServer: it takes sockets that the
    // engine's own listener accepted and never binds one.
    const wsUsers = kit.filter(({ source }) => source.includes("from 'ws'"));
    expect(wsUsers.map(({ file }) => file)).toEqual(['ws/upgrade.ts']);
    expect(wsUsers[0]?.source).toContain('noServer: true');
  });
});

describe('kit-loc', () => {
  it('AC-2 the kit stays at or below 800 lines of code', () => {
    const { status, out } = run('--json');
    const report = JSON.parse(out) as { total: number; max: number };
    expect(report.max).toBe(800);
    expect(report.total).toBeGreaterThan(100);
    expect(report.total).toBeLessThanOrEqual(800);
    expect(status).toBe(0);
  });

  it('AC-2 the gate counts code only, ignores specs and test support, and fails above the cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-loc-'));
    try {
      mkdirSync(join(dir, 'testing'));
      writeFileSync(
        join(dir, 'a.ts'),
        [
          '// a comment',
          '/** A doc',
          ' * comment',
          ' */',
          '',
          'export const a = 1; // trailing comment still counts the line',
          '/* inline */ export const b = 2;',
          '/* open',
          'still comment */ export const c = 3;',
          'export const d = `',
          '// looks like a comment, so the lexical count skips it',
          '`;',
        ].join('\n'),
      );
      writeFileSync(join(dir, 'a.spec.ts'), 'export const x = 1;\n'.repeat(50));
      writeFileSync(
        join(dir, 'testing', 'h.ts'),
        'export const y = 1;\n'.repeat(50),
      );
      writeFileSync(join(dir, 'notes.md'), 'x\n'.repeat(50));
      const count = (max: number) =>
        run('--dir', dir, '--max', String(max), '--json');
      const report = JSON.parse(count(100).out) as { total: number };
      expect(report.total).toBe(5);
      expect(count(5).status).toBe(0);
      const over = count(4);
      expect(over.status).toBe(1);
      expect(over.err).toContain('caps it at 4');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
