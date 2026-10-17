// A lab-cell stub in apps/conformance for one conformance id. A cell makes two assertions
// (blueprint 5.2): the live run matches the evidence recorded in testing/lab-evidence, and the
// registry cell matches that evidence. The evidence itself is recorded by a separate job and
// committed by a human (CODEOWNERS: lab-evidence), so this generator never writes it.
import type { Tree } from '@nx/devkit';

import { ensureLibrary, type LibrarySpec } from '../shared/library.ts';
import { quote } from '../shared/names.ts';
import { Writer } from '../shared/writer.ts';
import type { ConformanceCellOptions } from './schema.ts';

const ROOT = 'apps/conformance';
const CF_ID = /^CF-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;

function hostProject(): LibrarySpec {
  return {
    name: 'conformance',
    type: 'test',
    runtime: 'node',
    root: ROOT,
    trustCritical: false,
    importPath: null,
    projectType: 'application',
    readme: {
      purpose:
        'The conformance suite: one cell per conformance id, run against recorded lab evidence and a live broker.',
      publicApi: ['Nothing: the cells are specs in `src/cells/`.'],
      invariants: [
        'Every cell asserts that the live run matches the recorded evidence and that the registry cell matches it (blueprint 5.2).',
        'Evidence in `testing/lab-evidence/` is recorded by a separate job and committed by a human; a cell never writes it.',
        'This project may import amqplib (third-party confinement, blueprint 2.4).',
      ],
    },
    files: {
      'src/index.ts': `// The suite is the specs in src/cells; there is no code API.
export {};
`,
      'src/index.spec.ts': `import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('conformance public API', () => {
  it('exports no code', () => {
    expect(Object.keys(api)).toEqual([]);
  });
});
`,
    },
  };
}

export function cellSpec(cf: string): string {
  return `// Lab cell ${cf}. The evidence file testing/lab-evidence/<broker-version>/${cf}.json is
// recorded by \`conformance:record\` and committed by a human; do not create it here.
import { describe, it } from 'vitest';

describe(${quote(cf)}, () => {
  it.todo('the live run matches the recorded evidence');
  it.todo('the registry cell matches the recorded evidence');
});
`;
}

export async function conformanceCellGenerator(
  tree: Tree,
  options: ConformanceCellOptions,
): Promise<void> {
  const writer = new Writer(tree);
  if (!CF_ID.test(options.id)) {
    throw new Error(
      `"${options.id}" must be a conformance id such as CF-QQ-42-GUARD-01.`,
    );
  }
  const path = `${ROOT}/src/cells/${options.id.toLowerCase()}.cell.spec.ts`;
  if (writer.exists(path)) throw new Error(`${path} already exists.`);

  ensureLibrary(writer, hostProject());
  writer.write(path, cellSpec(options.id));

  await writer.flush();
}

export default conformanceCellGenerator;
