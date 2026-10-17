// RuleTester setup shared by the rule specs. ESLint's RuleTester finds `describe`/`it` globals;
// Vitest has none by default, so they are wired in here.
import angular from 'angular-eslint';
import { RuleTester } from 'eslint';
import json from '@eslint/json';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

/** TypeScript source, as the engine and UI libraries are linted. */
export function typescriptTester(): RuleTester {
  return new RuleTester({
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2023,
      sourceType: 'module',
    },
  });
}

/** Angular templates, parsed with the same parser the workspace config uses. */
export function templateTester(): RuleTester {
  return new RuleTester({
    languageOptions: { parser: angular.templateParser },
  });
}

/** i18n JSON files, linted with @eslint/json. */
export function jsonTester(): RuleTester {
  return new RuleTester({
    plugins: { json },
    language: 'json/json',
  });
}
