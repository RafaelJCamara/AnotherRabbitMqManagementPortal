import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readLabVersions, VERSIONS_FILE } from './lab-versions.ts';
import {
  CONFORMANCE_PROJECTS,
  planConformance,
  printableName,
} from './plan.ts';
import type { PlanInput } from './plan.ts';
import { verdict } from './verdict.ts';

const root = join(import.meta.dirname, '..', '..', '..');
const pinned = readLabVersions(join(root, VERSIONS_FILE));

const input = (patch: Partial<PlanInput>): PlanInput => ({
  affectedProjects: ['web'],
  changedFiles: ['apps/web/src/main.ts'],
  versions: pinned,
  shards: 2,
  ...patch,
});

describe('planConformance', () => {
  it('AC-1 an affected change plans every lab version in every shard on the pinned Node', () => {
    expect(pinned).toEqual(['3.13.7', '4.0.9', '4.1.8', '4.2.9', '4.3.6']);
    const expected = pinned.flatMap((version) =>
      [1, 2].map((shard) => ({ version, shard: `${String(shard)}/2` })),
    );
    // Each project that can change what the matrix shows, on its own.
    for (const project of CONFORMANCE_PROJECTS) {
      const plan = planConformance(input({ affectedProjects: [project] }));
      expect(plan.affected, project).toBe(true);
      expect(plan.matrix.include, project).toEqual(expected);
      expect(plan.reasons).toContain(`project ${project} is affected`);
    }
    // A conformance workflow or the setup action, with no project affected.
    for (const file of [
      '.github/workflows/conformance-pr.yml',
      '.github/workflows/conformance-nightly.yml',
      '.github/actions/setup/action.yml',
    ]) {
      const plan = planConformance(
        input({ affectedProjects: [], changedFiles: [file] }),
      );
      expect(plan.affected, file).toBe(true);
      expect(plan.matrix.include, file).toEqual(expected);
      expect(plan.reasons, file).toEqual([`${file} changed`]);
    }
    // The shard count is the plan's, in the form conformance:test takes.
    expect(
      planConformance(
        input({ affectedProjects: ['semantics'], shards: 3 }),
      ).matrix.include.map((e) => e.shard),
    ).toEqual(pinned.flatMap(() => ['1/3', '2/3', '3/3']));

    // The lab job takes its Node from .nvmrc: it passes the setup action no override.
    expect(readFileSync(join(root, '.nvmrc'), 'utf8').trim()).toBe('24.22.0');
    const workflow = parse(
      readFileSync(join(root, '.github/workflows/conformance-pr.yml'), 'utf8'),
    ) as {
      jobs: { lab: { steps: { uses?: string; with?: unknown }[] } };
    };
    const setup = workflow.jobs.lab.steps.filter(
      (step) => step.uses === './.github/actions/setup',
    );
    expect(setup).toHaveLength(1);
    expect(setup[0]?.with).toBeUndefined();
  });

  it('AC-2 an unaffected change plans nothing and still reports a passing check', () => {
    const plan = planConformance(
      input({
        affectedProjects: ['web', 'docs', 'engine'],
        changedFiles: ['apps/web/src/main.ts', 'docs/x.md'],
      }),
    );
    expect(plan.affected).toBe(false);
    expect(plan.matrix.include).toEqual([]);
    expect(plan.reasons.join(' ')).toMatch(/not affected/);
    // The required check still reports: pass, with the reason that nothing was affected.
    const decision = verdict({
      affected: plan.affected,
      plan: 'success',
      lab: 'skipped',
    });
    expect(decision.pass).toBe(true);
    expect(decision.reason).toMatch(/not affected/);
  });

  it('AC-3 an unknown base or a failed affected query runs the matrix', () => {
    const everything = pinned.length * 2;
    for (const patch of [
      { affectedProjects: null },
      { changedFiles: null },
      { affectedProjects: null, changedFiles: null },
    ] satisfies Partial<PlanInput>[]) {
      const plan = planConformance(input(patch));
      expect(plan.affected, JSON.stringify(patch)).toBe(true);
      expect(plan.matrix.include).toHaveLength(everything);
      expect(plan.reasons.join(' ')).toMatch(/could not be computed|unknown/);
    }
    // Known and unaffected is the only way to skip.
    expect(planConformance(input({})).affected).toBe(false);
  });

  it('refuses a plan it cannot trust: no versions, a range, a bad shard count', () => {
    expect(() => planConformance(input({ versions: [] }))).toThrow(/no lab/);
    expect(() => planConformance(input({ versions: ['4.x'] }))).toThrow(
      /exact/,
    );
    expect(() => planConformance(input({ shards: 0 }))).toThrow(/shards/);
    expect(() => planConformance(input({ shards: 1.5 }))).toThrow(/shards/);
  });

  it('lists at most a few changed files as reasons and counts the rest', () => {
    const files = Array.from(
      { length: 8 },
      (_, i) => `tools/conformance-ci/src/f${String(i)}.ts`,
    );
    const plan = planConformance(input({ changedFiles: files }));
    expect(plan.reasons).toHaveLength(6);
    expect(plan.reasons.at(-1)).toBe('and 3 more watched file(s) changed');
  });

  it('AC-8 (M0-FIX-1) the conformance project list is pinned', () => {
    // A project that drops out of the list stops triggering the matrix without any test noticing,
    // so the list is written out here; changing it is a decision to make on purpose.
    expect([...CONFORMANCE_PROJECTS]).toEqual([
      'semantics',
      'conformance',
      'adapter-amqp091',
      'adapter-mgmt-http',
      'broker-lab',
      'testkit',
    ]);
    // Every name is a real Nx project (a rename would otherwise leave a name that matches nothing).
    const names = new Set<string>();
    const scan = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') scan(path);
        } else if (entry.name === 'project.json') {
          const { name } = JSON.parse(readFileSync(path, 'utf8')) as {
            name?: unknown;
          };
          if (typeof name === 'string') names.add(name);
        }
      }
    };
    for (const top of ['apps', 'libs', 'tools', 'testing']) {
      scan(join(root, top));
    }
    for (const project of CONFORMANCE_PROJECTS) {
      expect(names.has(project), project).toBe(true);
    }
    // And each one, affected alone, runs the matrix (the list is what the plan reads).
    for (const project of CONFORMANCE_PROJECTS) {
      expect(
        planConformance(input({ affectedProjects: [project] })).affected,
        project,
      ).toBe(true);
    }
  });

  it('AC-10 (M0-FIX-1) a file name cannot inject a line into a reason', () => {
    const hostile = [
      'tools/conformance-ci/src/a\n::error::forged.ts',
      'tools/conformance-ci/src/b\r\n::set-output name=affected::false.ts',
      'tools/conformance-ci/src/c\u001b[31m.ts',
      'tools/conformance-ci/src/d‮gnp.ts',
      'tools/conformance-ci/src/e f g\u0085h.ts',
    ];
    const plan = planConformance(
      input({ affectedProjects: [], changedFiles: hostile }),
    );
    // Still watched (the prefix test reads the real name) and still a reason each.
    expect(plan.affected).toBe(true);
    expect(plan.reasons).toEqual([
      'tools/conformance-ci/src/a?::error::forged.ts changed',
      'tools/conformance-ci/src/b??::set-output name=affected::false.ts changed',
      'tools/conformance-ci/src/c?[31m.ts changed',
      'tools/conformance-ci/src/d?gnp.ts changed',
      'tools/conformance-ci/src/e?f?g?h.ts changed',
    ]);
    for (const reason of plan.reasons) {
      expect(reason).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    }
    // An ordinary name, spaces and non-ASCII letters included, is kept as it is.
    expect(printableName('tools/conformance-ci/src/é ü.ts')).toBe(
      'tools/conformance-ci/src/é ü.ts',
    );
  });

  it('a change under testing/lab-evidence or tools/conformance-ci counts, a look-alike path does not', () => {
    expect(
      planConformance(
        input({
          changedFiles: ['testing/lab-evidence/4.3.6/CF-SMOKE-01.json'],
        }),
      ).affected,
    ).toBe(true);
    expect(
      planConformance(
        input({ changedFiles: ['tools/conformance-ci-extra/x.ts'] }),
      ).affected,
    ).toBe(false);
    expect(
      planConformance(input({ changedFiles: ['docs/.github/actions/setup/x'] }))
        .affected,
    ).toBe(false);
  });
});
