// The architecture rules, run against the real tree.
import { fileURLToPath } from 'node:url';

import { checkPlanPurity } from '@app/kernel';
import { describe, expect, it } from 'vitest';

import { registeredActions } from './registered-actions.ts';
import {
  checkMutationFunnel,
  checkProofMinting,
  checkRecorderIndependence,
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

  it('M0-15 AC-2 apps/conformance/src/record (and the driver, the DSL and the scenarios) import nothing from @app/semantics', () => {
    const paths = sources.map((source) => source.path);

    // The generators' end-to-end copy of the workspace has no apps/conformance; the real tree has
    // it, and then the files the rule is about must be where it looks (a moved folder must not
    // make the rule pass for want of anything to check).
    if (paths.some((path) => path.startsWith('apps/conformance/'))) {
      expect(paths).toContain('apps/conformance/src/record/record.ts');
      expect(paths).toContain('apps/conformance/src/driver/amqp091-raw.ts');
      expect(paths).toContain('apps/conformance/src/dsl.ts');
    }
    expect(checkRecorderIndependence(sources)).toEqual([]);
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
