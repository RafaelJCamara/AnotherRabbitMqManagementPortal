import { describe, expect, it } from 'vitest';

import {
  diffOf,
  expectFormatted,
  parseJson,
  workspaceTree,
} from '../shared/test-utils.ts';
import { lintRuleGenerator } from './generator.ts';

const root = 'libs/shared/lint-rules';

describe('lint-rule', () => {
  it('creates the library on first use, with the rule, fixtures and spec', async () => {
    const tree = workspaceTree();

    const { created } = await diffOf(tree, () =>
      lintRuleGenerator(tree, {
        id: 'queue-without-dlx',
        severity: 'error',
        since: '4.3',
      }),
    );

    expect(created).toMatchSnapshot();
    await expectFormatted(created);
  });

  it('tags the library type:pure and runtime:isomorphic', async () => {
    const tree = workspaceTree();

    const { created } = await diffOf(tree, () =>
      lintRuleGenerator(tree, { id: 'demo-rule', since: '4.3' }),
    );

    expect(
      parseJson<{ tags: string[] }>(created[`${root}/project.json`]).tags,
    ).toEqual(['type:pure', 'runtime:isomorphic']);
  });

  it('appends a second rule to the registry without recreating the library', async () => {
    const tree = workspaceTree();
    await lintRuleGenerator(tree, { id: 'first-rule', since: '4.3' });

    const { created, updated } = await diffOf(tree, () =>
      lintRuleGenerator(tree, {
        id: 'second-rule',
        severity: 'info',
        since: '4.4.0',
      }),
    );

    expect(Object.keys(created).sort()).toEqual([
      `${root}/src/rules/second-rule.fixtures.ts`,
      `${root}/src/rules/second-rule.spec.ts`,
      `${root}/src/rules/second-rule.ts`,
    ]);
    const registry = updated[`${root}/src/rules/index.ts`] ?? '';
    expect(registry).toContain("import { firstRule } from './first-rule';");
    expect(registry).toContain("import { secondRule } from './second-rule';");
    expect(registry).toMatch(/\[\s*firstRule,\s*secondRule,?\s*\]/);
  });

  it('accepts the number the Nx CLI makes of --since=4.3', async () => {
    const tree = workspaceTree();

    await lintRuleGenerator(tree, { id: 'demo-rule', since: 4.3 });

    expect(tree.read(`${root}/src/rules/demo-rule.ts`, 'utf-8')).toContain(
      "since: '4.3'",
    );
  });

  it.each(['four', '4', '4.3.1.2', 'v4.3'])(
    'refuses --since=%s',
    async (since) => {
      await expect(
        lintRuleGenerator(workspaceTree(), { id: 'demo-rule', since }),
      ).rejects.toThrow('must be a broker version');
    },
  );

  it('refuses a rule that already exists', async () => {
    const tree = workspaceTree();
    await lintRuleGenerator(tree, { id: 'demo-rule', since: '4.3' });

    await expect(
      lintRuleGenerator(tree, { id: 'demo-rule', since: '4.3' }),
    ).rejects.toThrow('already exists');
  });
});
