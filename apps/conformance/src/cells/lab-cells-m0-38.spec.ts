// A change to a settle scenario or projection edits no registry cell and no evidence file (OQ-578).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PROJECTIONS } from '../assert/projections.ts';
import { SCENARIOS } from '../scenarios/index.ts';

const WIRED = ['CF-SETTLE-01', 'CF-SETTLE-02', 'CF-SETTLE-05'];
const REPO = join(import.meta.dirname, '..', '..', '..', '..');
const SETTLE =
  /^apps\/conformance\/src\/(scenarios\/(cf-settle-|settle-return)|assert\/projections-settle)/;
const PROTECTED =
  /^(testing\/lab-evidence\/|libs\/shared\/semantics\/src\/data\/)/;

describe('the M0-38 lab cells', () => {
  it('AC-23 no registry cell or evidence file changed and every wired id has a scenario and a projection', (context) => {
    for (const id of WIRED) {
      const stub = join(
        import.meta.dirname,
        `${id.toLowerCase()}.cell.spec.ts`,
      );
      expect(readFileSync(stub, 'utf8'), id).toContain(
        `describeThreeWay('${id}')`,
      );
      expect(
        SCENARIOS.map((s) => s.cfId),
        id,
      ).toContain(id);
      expect(PROJECTIONS[id], id).toBeTypeOf('function');
    }
    // Scoped to this change, not to the repository: a maintainer's commit that records evidence and
    // flips a status edits no settle scenario, so it does not turn this red.
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
    const base = process.env.CONFORMANCE_BASE ?? 'origin/main';
    const [diff, fresh] = [
      git('diff', '--name-only', base),
      git('ls-files', '--others', '--exclude-standard'),
    ];
    if (diff.status !== 0) context.skip(`git cannot compare with ${base}`);
    const changed = `${diff.stdout}\n${fresh.stdout}`.split('\n');
    if (changed.some((file) => SETTLE.test(file))) {
      expect(changed.filter((file) => PROTECTED.test(file))).toEqual([]);
    }
  });
});
