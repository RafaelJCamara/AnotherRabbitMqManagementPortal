// A project-specific ESLint rule in tools/eslint-rules (M0-04): the rule, its RuleTester spec,
// the registration in src/index.ts, the `projectRules` entry that scopes it by path, the row in
// the project README, and a path-scoping case in tools/lint-selftest. The rule body is inert
// (it only reports a placeholder call) until the invariant is implemented.
import { logger, type Tree } from '@nx/devkit';

import { addProjectRule } from '../shared/eslint-config.ts';
import {
  assertKebab,
  nameVariants,
  quote,
  splitList,
} from '../shared/names.ts';
import { Writer } from '../shared/writer.ts';
import type { EslintRuleOptions } from './schema.ts';

const RULES = 'tools/eslint-rules';
const INDEX = `${RULES}/src/index.ts`;
const README = `${RULES}/README.md`;
const SELFTEST = 'tools/lint-selftest/src/project-rules.spec.ts';

const IMPORT_LINE = /^import \{ \w+ \} from '\.\/rules\/([\w-]+)\.ts';$/;
const RULE_LINE = /^ {2}'([\w-]+)': \w+,$/;

/** Inserts `line` before the first matching line that sorts after `key`, else after the last. */
function insertSorted(
  lines: string[],
  pattern: RegExp,
  key: string,
  line: string,
  what: string,
): void {
  const matches = lines.flatMap((text, index) => {
    const found = pattern.exec(text);
    return found?.[1] ? [{ index, key: found[1] }] : [];
  });
  const last = matches.at(-1);
  if (!last) {
    throw new Error(`${INDEX}: found no ${what}; was the file restructured?`);
  }
  const next = matches.find((match) => match.key > key);
  lines.splice(next ? next.index : last.index + 1, 0, line);
}

export function registerRule(index: string, id: string, camel: string): string {
  if (index.includes(`'${id}':`)) {
    throw new Error(`${INDEX} already registers a rule named ${id}.`);
  }
  const lines = index.split('\n');
  insertSorted(
    lines,
    IMPORT_LINE,
    id,
    `import { ${camel} } from './rules/${id}.ts';`,
    'rule imports',
  );
  insertSorted(lines, RULE_LINE, id, `  '${id}': ${camel},`, 'rule entries');
  return lines.join('\n');
}

export function ruleSource(
  id: string,
  camel: string,
  invariant: string,
  description: string,
): string {
  return `// ${invariant}
import { defineRule } from '../utils.ts';

export const ${camel} = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description: ${quote(description)},
    },
    schema: [],
    messages: {
      violation: ${quote(`${description} (${id})`)},
    },
  },
  create(context) {
    return {
      // Replace this visitor with the real check. Until then the rule only reports calls to a
      // placeholder function, so it cannot produce a false positive.
      CallExpression(node) {
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === '${camel}Placeholder'
        ) {
          context.report({ node, messageId: 'violation' });
        }
      },
    };
  },
});
`;
}

export function ruleSpec(id: string, camel: string): string {
  return `import { typescriptTester } from '../test-utils.ts';
import { ${camel} } from './${id}.ts';

typescriptTester().run('${id}', ${camel}, {
  valid: ['doSomething();'],
  invalid: [
    {
      code: '${camel}Placeholder();',
      errors: [{ messageId: 'violation' }],
    },
  ],
});
`;
}

function readmeRow(
  id: string,
  invariant: string,
  directories: string[],
): string {
  const applies = directories.map((dir) => `\`${dir}/**\``).join(', ');
  return `| \`${id}\` | ${invariant.replace(/\|/g, '\\|')} | ${applies} |`;
}

function selftestCase(id: string, camel: string, directory: string): string {
  return `
describe('${id}', () => {
  it('fails the placeholder call under ${directory}', async () => {
    const violations = await lintAs(
      '${directory}/lint-selftest-sample/src/${id}.ts',
      '${camel}Placeholder();\\n',
    );

    expect(rulesOf(violations)).toEqual(['@app/${id}']);
  });
});
`;
}

export async function eslintRuleGenerator(
  tree: Tree,
  options: EslintRuleOptions,
): Promise<void> {
  const writer = new Writer(tree);
  assertKebab(options.id, 'rule id');
  const id = options.id;
  const { camel } = nameVariants(id);
  const directories = splitList(options.paths ?? 'libs,apps');
  if (directories.length === 0) {
    throw new Error(
      '--paths needs at least one directory, for example libs,apps.',
    );
  }
  const invariant = (
    options.invariant ??
    'Name the invariant (I-n, DC-n or ADR-n) this rule guards.'
  )
    .replace(/\s+/g, ' ')
    .trim();
  const description = options.description ?? `Guards: ${invariant}`;

  if (writer.exists(`${RULES}/src/rules/${id}.ts`)) {
    throw new Error(`${RULES}/src/rules/${id}.ts already exists.`);
  }
  const index = writer.require(INDEX, 'Is tools/eslint-rules missing?');
  writer.write(
    `${RULES}/src/rules/${id}.ts`,
    ruleSource(id, camel, invariant, description),
  );
  writer.write(`${RULES}/src/rules/${id}.spec.ts`, ruleSpec(id, camel));
  writer.write(INDEX, registerRule(index, id, camel));

  addProjectRule(writer, { id, invariant, directories });

  const readme = writer.read(README);
  if (readme !== null) {
    const lines = readme.split('\n');
    const lastRow = lines.findLastIndex((line) => line.startsWith('| `'));
    if (lastRow !== -1) {
      lines.splice(lastRow + 1, 0, readmeRow(id, invariant, directories));
      writer.write(README, lines.join('\n'));
    }
  }

  const selftest = writer.read(SELFTEST);
  if (selftest === null) {
    logger.warn(
      `${SELFTEST} not found: add a path-scoping case for ${id} by hand.`,
    );
  } else {
    writer.write(
      SELFTEST,
      `${selftest.trimEnd()}\n${selftestCase(id, camel, directories[0] ?? 'libs')}`,
    );
  }

  await writer.flush();
}

export default eslintRuleGenerator;
