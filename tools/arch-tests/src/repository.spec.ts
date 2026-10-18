// The architecture rules, run against the real tree.
import { fileURLToPath } from 'node:url';

import { checkPlanPurity } from '@app/kernel';
import { describe, expect, it } from 'vitest';

import { registeredActions } from './registered-actions.ts';
import {
  checkMutationFunnel,
  checkProofMinting,
  findActionSites,
} from './rules.ts';
import { listSources } from './sources.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sources = listSources(root);

describe('architecture: the real tree', () => {
  it('reads the sources it is meant to check', () => {
    const paths = sources.map((source) => source.path);

    expect(paths).toContain('libs/engine/kernel/src/actions/executor.ts');
    expect(paths).toContain('libs/engine/ports/src/proofs.ts');
    expect(paths.some((path) => path.includes('node_modules'))).toBe(false);
    expect(
      paths.some((path) => path.startsWith('tools/lint-selftest/fixtures/')),
    ).toBe(false);
  });

  it('I-2 write-capable ports are named only in action and job modules, outside the plumbing', () => {
    expect(checkMutationFunnel(sources)).toEqual([]);
  });

  it('A-9 settlement proofs are minted only where the amendment allows', () => {
    expect(checkProofMinting(sources)).toEqual([]);
  });

  it('AC-2 plan() of every registered action passes against write ports that throw', async () => {
    const samples = registeredActions();

    expect(await checkPlanPurity(samples)).toEqual([]);
  });

  it('every implementAction call site is in the plan-purity manifest, and the manifest has nothing else', () => {
    const sites = findActionSites(sources);
    const listed = registeredActions();

    expect(sites.map((site) => site.path).sort()).toEqual(
      [...new Set(listed.map((entry) => entry.path))].sort(),
    );
    expect(sites.reduce((sum, site) => sum + site.calls, 0)).toBe(
      listed.length,
    );
  });
});
