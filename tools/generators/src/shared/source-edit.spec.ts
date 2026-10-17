import { describe, expect, it } from 'vitest';

import {
  appendImport,
  appendToArray,
  arrayElements,
  arrayOfObjects,
} from './source-edit.ts';

describe('appendToArray', () => {
  it('appends after the last element of a multi-line array', () => {
    const text = 'export const list = [\n  a,\n  b,\n];\n';

    expect(
      arrayElements(appendToArray(text, 'x.ts', 'list', 'c'), 'x.ts', 'list'),
    ).toEqual(['a', 'b', 'c']);
  });

  it('adds the missing comma and fills an empty array', () => {
    expect(
      arrayElements(
        appendToArray('const list = [a];\n', 'x.mjs', 'list', 'b'),
        'x.mjs',
        'list',
      ),
    ).toEqual(['a', 'b']);
    expect(
      arrayElements(
        appendToArray('const list = [];\n', 'x.mjs', 'list', 'a'),
        'x.mjs',
        'list',
      ),
    ).toEqual(['a']);
  });

  it('sees through a type annotation and `as const`', () => {
    const annotated = 'export const list: readonly string[] = [];\n';
    const asConst = "export const list = ['a'] as const;\n";

    expect(appendToArray(annotated, 'x.ts', 'list', "'a'")).toContain("'a'");
    expect(appendToArray(asConst, 'x.ts', 'list', "'b'")).toContain("'b'");
  });

  it('ignores comments and a same-named array nested elsewhere', () => {
    const text =
      '// const list = [1];\nconst other = { list: [1] };\nconst list = [\n  a, // first\n];\n';

    expect(
      arrayElements(appendToArray(text, 'x.mjs', 'list', 'b'), 'x.mjs', 'list'),
    ).toEqual(['a', 'b']);
  });

  it('names the missing array', () => {
    expect(() =>
      appendToArray('const a = [];\n', 'x.mjs', 'list', 'b'),
    ).toThrow('no top-level array named "list"');
  });
});

describe('arrayOfObjects', () => {
  it('reads string-array properties and skips what is not a literal', () => {
    const text =
      "const rows = [{ names: ['a', 'b'], only: ['x'] }, { names: [dynamic], other: 1 }, notAnObject];\n";

    expect(arrayOfObjects(text, 'x.mjs', 'rows')).toEqual([
      { names: ['a', 'b'], only: ['x'] },
      { names: [], other: [] },
    ]);
  });
});

describe('appendImport', () => {
  it('adds an import after the last one and is idempotent', () => {
    const text =
      "import a from 'a';\nimport b from 'b';\n\nexport const x = a + b;\n";
    const once = appendImport(text, 'x.ts', "import c from 'c';");

    expect(once).toBe(
      "import a from 'a';\nimport b from 'b';\nimport c from 'c';\n\nexport const x = a + b;\n",
    );
    expect(appendImport(once, 'x.ts', "import c from 'c';")).toBe(once);
  });

  it('puts the import first when there are none', () => {
    expect(
      appendImport('export const x = 1;\n', 'x.ts', "import c from 'c';"),
    ).toBe("import c from 'c';\nexport const x = 1;\n");
  });
});
