// End-to-end proof (M0-08): every generator runs through the real `nx g` CLI in a throwaway copy
// of the workspace, and what it made must pass the full lint (module boundaries, confinement and
// the @app rules), typecheck and test through its own project.json targets, and be Prettier-clean.
// The confinement and boundary rules are then shown to bite on the generated projects.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TempWorkspace, type RunResult } from './workspace.ts';

let workspace: TempWorkspace;

const ok = (result: RunResult): void => {
  expect(result.status, result.output).toBe(0);
};

const generate = (name: string, ...args: string[]): void => {
  ok(workspace.nx('g', `@app/generators:${name}`, ...args, '--no-interactive'));
};

const write = (path: string, content: string): void => {
  const full = join(workspace.root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
};

interface Message {
  ruleId: string | null;
  message: string;
}

/** What ESLint reports for `path`, whatever else (type information, unresolved imports) it says. */
const messages = (path: string): Message[] => {
  const result = workspace.eslint('--format', 'json', path);
  const report = JSON.parse(result.output) as { messages: Message[] }[];
  return report.flatMap((file) => file.messages);
};

const PROJECTS = [
  'demo-pure',
  'svc-demo',
  'adapter-demo',
  'feature-demo',
  'lint-rules',
  'decoders',
  'header-registry',
  'semantics',
  'conformance',
  'persistence',
  'eslint-rules',
  'lint-selftest',
];

beforeAll(() => {
  workspace = new TempWorkspace();

  generate('library', 'demo-pure', '--type=pure');
  generate('service-module', 'svc-demo', '--trust-critical');
  generate('adapter', 'demo', '--port=DemoPort', '--confine=left-pad');
  generate('ui-feature', 'demo', '--route=/c/:cid/demo');
  generate(
    'eslint-rule',
    'no-demo-thing',
    '--invariant=I-99 demo things stay out',
    '--paths=libs',
  );
  generate('lint-rule', 'demo-rule', '--severity=warn', '--since=4.3');
  generate('decoder', 'demo-framework', '--tier=builtin');
  generate('decoder', 'data-framework', '--tier=declarative');
  generate(
    'semantics-cell',
    '--era=4.3',
    '--queue-type=quorum',
    '--protocol=amqp091',
    '--action=amqp091.nack_requeue',
    '--cf=CF-DEMO-01',
  );
  generate('conformance-cell', 'CF-DEMO-01');
  generate('migration', 'core');
  generate('migration', 'data-keys');

  // The generated service imports the kernel, which imports the ports. The adapter generator had
  // to run without that alias (it would import the made-up DemoPort from it), so it comes back now.
  workspace.restoreAlias('@app/ports');

  // A real cross-project import, to prove the path alias works for lint, typecheck and test.
  write('libs/shared/demo-pure/src/answer.ts', 'export const answer = 42;\n');
  write(
    'libs/shared/demo-pure/src/index.ts',
    "export { answer } from './answer';\n",
  );
  write(
    'libs/shared/demo-pure/src/index.spec.ts',
    "import { expect, it } from 'vitest';\n\nimport * as api from './index';\n\nit('exports answer', () => {\n  expect(Object.keys(api)).toEqual(['answer']);\n});\n",
  );
  write(
    'libs/engine/svc-demo/src/uses-pure.ts',
    "import { answer } from '@app/demo-pure';\n\nexport const doubled = answer * 2;\n",
  );
  write(
    'libs/engine/svc-demo/src/uses-pure.spec.ts',
    "import { expect, it } from 'vitest';\n\nimport { doubled } from './uses-pure';\n\nit('resolves @app/demo-pure', () => {\n  expect(doubled).toBe(84);\n});\n",
  );
}, 600_000);

afterAll(() => {
  workspace.dispose();
});

describe('generated projects', () => {
  it('are already formatted', () => {
    ok(
      workspace.prettier(
        '--check',
        'libs',
        'apps',
        'testing',
        'tools/eslint-rules',
        'tools/lint-selftest/src',
        'eslint.config.mjs',
        'tsconfig.base.json',
      ),
    );
  });

  it('pass lint, typecheck and test through their own targets', () => {
    ok(
      workspace.nx(
        'run-many',
        '-t',
        'lint',
        'typecheck',
        'test',
        '-p',
        PROJECTS.join(','),
        '--skip-nx-cache',
        '--parallel=2',
      ),
    );
  }, 900_000);
});

describe('confinement and boundaries of generated projects', () => {
  const importLeftPad =
    "import leftPad from 'left-pad';\n\nexport const padded = leftPad;\n";

  it('allows the confined package inside the adapter', () => {
    write('libs/engine/adapter-demo/src/uses-left-pad.ts', importLeftPad);

    const rules = messages('libs/engine/adapter-demo/src/uses-left-pad.ts').map(
      (message) => message.ruleId,
    );

    expect(rules).not.toContain('no-restricted-imports');
  });

  it('rejects the confined package in any other project', () => {
    write('libs/engine/svc-demo/src/uses-left-pad.ts', importLeftPad);

    const found = messages('libs/engine/svc-demo/src/uses-left-pad.ts').filter(
      (message) => message.ruleId === 'no-restricted-imports',
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain(
      'left-pad may only be imported from libs/engine/adapter-demo (blueprint 2.4, third-party confinement).',
    );
  });

  it('rejects a service that imports an adapter', () => {
    write(
      'libs/engine/svc-demo/src/uses-adapter.ts',
      "import { createDemoAdapter } from '@app/adapter-demo';\n\nexport const make = createDemoAdapter;\n",
    );

    const rules = messages('libs/engine/svc-demo/src/uses-adapter.ts').map(
      (message) => message.ruleId,
    );

    expect(rules).toContain('@nx/enforce-module-boundaries');
  });
});
