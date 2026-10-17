import { join } from 'node:path';

import { ESLint, type Linter } from 'eslint';
import tseslint from 'typescript-eslint';

/** Workspace root (this file lives in tools/lint-selftest/src). */
export const workspaceRoot = join(import.meta.dirname, '..', '..', '..');

export interface Violation {
  ruleId: string;
  message: string;
}

// The self-test lints planted files and virtual paths that are in no tsconfig, so type information
// is switched off. Every rule under test (boundaries, confinement) is syntactic.
const withoutTypeInformation: Linter.Config[] = [
  {
    files: ['**/*.ts'],
    ...(tseslint.configs.disableTypeChecked as Linter.Config),
    languageOptions: { parserOptions: { projectService: false } },
  },
];

const eslint = new ESLint({
  cwd: workspaceRoot,
  overrideConfigFile: join(workspaceRoot, 'eslint.config.mjs'),
  overrideConfig: withoutTypeInformation,
  // Planted violations live in ignored fixture directories.
  ignore: false,
});

function toViolations(results: ESLint.LintResult[]): Violation[] {
  return results.flatMap((result) =>
    result.messages
      .filter((message) => message.severity === 2)
      .map((message) => ({
        ruleId: message.ruleId ?? 'parse-error',
        message: message.message,
      })),
  );
}

/** Lints a real file under the workspace root (a planted violation). */
export async function lintFile(path: string): Promise<Violation[]> {
  return toViolations(await eslint.lintFiles([path]));
}

/** Lints `code` as if it lived at `path`, which does not need to exist. */
export async function lintAs(path: string, code: string): Promise<Violation[]> {
  return toViolations(
    await eslint.lintText(code, { filePath: join(workspaceRoot, path) }),
  );
}
