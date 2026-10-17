// Project-specific ESLint rules (M0-04). The plugin is registered as `@app` in eslint.config.mjs,
// so the rule ids are `@app/<rule>`. This file is loaded by Node directly (type stripping), so it
// uses only erasable TypeScript syntax and `.ts` import specifiers.
import type { ESLint } from 'eslint';

import { boundedBuffersOnly } from './rules/bounded-buffers-only.ts';
import { explicitZodSchemas } from './rules/explicit-zod-schemas.ts';
import { honestWording } from './rules/honest-wording.ts';
import { noBrokerVersionCompare } from './rules/no-broker-version-compare.ts';
import { noDirectFetch } from './rules/no-direct-fetch.ts';
import { noInnerHtml } from './rules/no-inner-html.ts';
import { noModeBranching } from './rules/no-mode-branching.ts';
import { uiNoRawTemplateText } from './rules/ui-no-raw-template-text.ts';

export const rules = {
  'bounded-buffers-only': boundedBuffersOnly,
  'explicit-zod-schemas': explicitZodSchemas,
  'honest-wording': honestWording,
  'no-broker-version-compare': noBrokerVersionCompare,
  'no-direct-fetch': noDirectFetch,
  'no-inner-html': noInnerHtml,
  'no-mode-branching': noModeBranching,
  'ui-no-raw-template-text': uiNoRawTemplateText,
};

const plugin: ESLint.Plugin = {
  meta: { name: '@app/eslint-rules', namespace: '@app' },
  rules,
};

export default plugin;
