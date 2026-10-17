import { describe, expect, it } from 'vitest';

import { diffOf, workspaceTree } from '../shared/test-utils.ts';
import { eslintRuleGenerator } from './generator.ts';

describe('eslint-rule', () => {
  it('creates the rule and its RuleTester spec', async () => {
    const tree = workspaceTree();

    const { created } = await diffOf(tree, () =>
      eslintRuleGenerator(tree, {
        id: 'no-demo-thing',
        invariant: 'I-99: demo things stay out',
      }),
    );

    expect(created).toMatchSnapshot();
  });

  it('registers the rule in index.ts in alphabetical order', async () => {
    const tree = workspaceTree();

    const { updated } = await diffOf(tree, () =>
      eslintRuleGenerator(tree, { id: 'no-demo-thing' }),
    );

    const index = updated['tools/eslint-rules/src/index.ts'] ?? '';
    expect(index).toContain(
      "import { noDemoThing } from './rules/no-demo-thing.ts';",
    );
    expect(index).toContain("  'no-demo-thing': noDemoThing,");
    const entries = [...index.matchAll(/^ {2}'([\w-]+)': \w+,$/gm)].map(
      (match) => match[1],
    );
    expect(entries).toEqual([...entries].sort());
  });

  it('scopes the rule by path in eslint.config.mjs', async () => {
    const tree = workspaceTree();

    const { updated } = await diffOf(tree, () =>
      eslintRuleGenerator(tree, {
        id: 'no-demo-thing',
        invariant: 'I-99: demo things stay out',
        paths: 'libs,apps',
      }),
    );

    const config = updated['eslint.config.mjs'] ?? '';
    expect(config).toContain("name: 'app/no-demo-thing'");
    expect(config).toContain("files: tsIn('libs', 'apps')");
    expect(config).toContain("rules: { '@app/no-demo-thing': 'error' }");
    expect(config).toContain('// I-99: demo things stay out');
  });

  it('adds a README row and a lint-selftest scoping case', async () => {
    const tree = workspaceTree();

    const { updated } = await diffOf(tree, () =>
      eslintRuleGenerator(tree, { id: 'no-demo-thing', paths: 'libs' }),
    );

    expect(updated['tools/eslint-rules/README.md']).toContain(
      '| `no-demo-thing` |',
    );
    const selftest = updated['tools/lint-selftest/src/project-rules.spec.ts'];
    expect(selftest).toContain("describe('no-demo-thing'");
    expect(selftest).toContain("['@app/no-demo-thing']");
  });

  it('refuses a rule that already exists', async () => {
    const tree = workspaceTree();

    await expect(
      eslintRuleGenerator(tree, { id: 'no-inner-html' }),
    ).rejects.toThrow('already registers a rule named no-inner-html');
  });

  it('refuses an id that is not kebab-case', async () => {
    await expect(
      eslintRuleGenerator(workspaceTree(), { id: 'noDemo' }),
    ).rejects.toThrow('kebab-case');
  });
});
