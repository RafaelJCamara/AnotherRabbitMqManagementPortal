// A broker lint rule (DC-56) in libs/shared/lint-rules: the rule, its fixtures per broker
// version, a spec that runs them, and the registration. The library is created on first use.
import type { Tree } from '@nx/devkit';

import { ensureLibrary, type LibrarySpec } from '../shared/library.ts';
import { assertKebab, nameVariants, quote } from '../shared/names.ts';
import { appendImport, appendToArray } from '../shared/source-edit.ts';
import { Writer } from '../shared/writer.ts';
import type { LintRuleOptions } from './schema.ts';

const ROOT = 'libs/shared/lint-rules';
const REGISTRY = `${ROOT}/src/rules/index.ts`;
const VERSION = /^\d+\.\d+(?:\.\d+)?$/;

const TYPES = `// The shape of a broker lint rule (DC-56). Rules are data-driven and runtime-neutral: they run
// in the engine, the CLI and the browser, so this library has no Node dependency.
export type LintSeverity = 'info' | 'warn' | 'error';

export interface LintFinding {
  readonly ruleId: string;
  readonly severity: LintSeverity;
  readonly message: string;
}

export interface LintRule {
  readonly id: string;
  readonly severity: LintSeverity;
  /** First broker version the rule applies to, for example 4.3. */
  readonly since: string;
  /** The input is the topology or profile snapshot; narrow it inside the rule. */
  check(input: unknown): readonly LintFinding[];
}

/** One fixture per broker version on which the rule behaves differently. */
export interface RuleFixture {
  readonly brokerVersion: string;
  readonly input: unknown;
  /** Messages of the findings the rule must report, in order. */
  readonly expected: readonly string[];
}
`;

function hostLibrary(): LibrarySpec {
  return {
    name: 'lint-rules',
    type: 'pure',
    runtime: 'isomorphic',
    root: ROOT,
    trustCritical: false,
    importPath: '@app/lint-rules',
    projectType: 'library',
    readme: {
      purpose:
        'The broker linter rules (DC-56): pure functions from a topology or profile snapshot to findings.',
      publicApi: [
        '`lintRules`: every registered rule.',
        '`LintRule`, `LintFinding`, `LintSeverity`, `RuleFixture`: the rule shape.',
      ],
      invariants: [
        'Rules are pure and isomorphic: no I/O, no `node:*` imports (type:pure).',
        'Every rule has fixtures for each broker version it behaves differently on, and a spec that runs them.',
        'Version differences are data in the semantics registry, not comparisons in a rule (I-3).',
      ],
      proof: ['pnpm nx test lint-rules'],
    },
    files: {
      'src/index.ts': `export type {
  LintFinding,
  LintRule,
  LintSeverity,
  RuleFixture,
} from './types';
export { lintRules } from './rules';
`,
      'src/types.ts': TYPES,
      'src/rules/index.ts': `import type { LintRule } from '../types';

export const lintRules: readonly LintRule[] = [];
`,
      'src/index.spec.ts': `import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('lint-rules public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual(['lintRules']);
  });
});
`,
      'src/rules/index.spec.ts': `import { describe, expect, it } from 'vitest';

import { lintRules } from './index';

describe('lintRules', () => {
  it('has unique ids', () => {
    const ids = lintRules.map((rule) => rule.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names a broker version for every rule', () => {
    for (const rule of lintRules) {
      expect(rule.since).toMatch(/^\\d+\\.\\d+(?:\\.\\d+)?$/);
    }
  });
});
`,
    },
  };
}

export function ruleFiles(
  id: string,
  camel: string,
  severity: string,
  since: string,
): Record<string, string> {
  return {
    [`src/rules/${id}.ts`]: `import type { LintFinding, LintRule } from '../types';

export const ${camel}: LintRule = {
  id: ${quote(id)},
  severity: ${quote(severity)},
  since: ${quote(since)},
  check(): readonly LintFinding[] {
    // Replace with the check. Report one finding per offending object.
    return [];
  },
};
`,
    [`src/rules/${id}.fixtures.ts`]: `import type { RuleFixture } from '../types';

/** One fixture per broker version on which the rule behaves differently; the first is \`since\`. */
export const ${camel}Fixtures: readonly RuleFixture[] = [
  { brokerVersion: ${quote(since)}, input: {}, expected: [] },
];
`,
    [`src/rules/${id}.spec.ts`]: `import { describe, expect, it } from 'vitest';

import { ${camel} } from './${id}';
import { ${camel}Fixtures } from './${id}.fixtures';
import { lintRules } from './index';

describe(${quote(id)}, () => {
  it('is registered', () => {
    expect(lintRules).toContain(${camel});
  });

  it('applies from broker ${since}', () => {
    expect(${camel}.since).toBe(${quote(since)});
  });

  it.each(${camel}Fixtures)(
    'reports the expected findings on broker $brokerVersion',
    (fixture) => {
      const messages = ${camel}.check(fixture.input).map((finding) => finding.message);

      expect(messages).toEqual(fixture.expected);
    },
  );
});
`,
  };
}

export async function lintRuleGenerator(
  tree: Tree,
  options: LintRuleOptions,
): Promise<void> {
  const writer = new Writer(tree);
  const since = String(options.since);
  assertKebab(options.id, 'rule id');
  const severity = options.severity ?? 'warn';
  if (!VERSION.test(since)) {
    throw new Error(
      `--since "${since}" must be a broker version such as 4.3 or 4.3.1.`,
    );
  }
  const { camel } = nameVariants(options.id);

  ensureLibrary(writer, hostLibrary());
  const registry = writer.require(
    REGISTRY,
    `${ROOT} exists but has no rule registry; restore src/rules/index.ts.`,
  );
  if (writer.exists(`${ROOT}/src/rules/${options.id}.ts`)) {
    throw new Error(`${ROOT}/src/rules/${options.id}.ts already exists.`);
  }

  for (const [path, content] of Object.entries(
    ruleFiles(options.id, camel, severity, since),
  )) {
    writer.write(`${ROOT}/${path}`, content);
  }
  const withImport = appendImport(
    registry,
    REGISTRY,
    `import { ${camel} } from './${options.id}';`,
  );
  writer.write(
    REGISTRY,
    appendToArray(withImport, REGISTRY, 'lintRules', camel),
  );

  await writer.flush();
}

export default lintRuleGenerator;
