import { describe, expect, it } from 'vitest';

import {
  appendImport,
  appendLine,
  appendToArray,
  appendToPropertyArray,
  arrayElements,
  arrayOfObjects,
  findPropertyArray,
} from './source-edit.ts';
import ts from 'typescript';

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

describe('appendToPropertyArray', () => {
  const registry =
    'export const registry: Registry = {\n  actions: [a, b],\n  topics: [],\n};\n';

  it('appends to the array property of an object, and to an empty one', () => {
    const withAction = appendToPropertyArray(
      registry,
      'r.ts',
      'registry',
      'actions',
      'c',
    );
    const withTopic = appendToPropertyArray(
      withAction,
      'r.ts',
      'registry',
      'topics',
      't',
    );

    expect(withTopic).toMatch(/actions: \[a, b,\s*c,?\s*\]/);
    expect(withTopic).toMatch(/topics: \[\s*t,?\s*\]/);
  });

  it('leaves the other property alone', () => {
    const next = appendToPropertyArray(
      registry,
      'r.ts',
      'registry',
      'actions',
      'c',
    );

    expect(next).toContain('topics: [],');
  });

  it('says what it expected when the object or the property is missing or not an array', () => {
    const parse = (text: string) =>
      ts.createSourceFile('r.ts', text, ts.ScriptTarget.Latest, true);

    expect(() =>
      findPropertyArray(parse(registry), 'other', 'actions'),
    ).toThrow(/no top-level object "other"/);
    expect(() =>
      findPropertyArray(parse(registry), 'registry', 'jobs'),
    ).toThrow(/array property "jobs"/);
    expect(() =>
      findPropertyArray(
        parse('const registry = { actions: 5 };'),
        'registry',
        'actions',
      ),
    ).toThrow(/array property "actions"/);
  });
});

describe('appendLine', () => {
  it('adds a line at the end, with one newline', () => {
    expect(
      appendLine("export * from './a.ts';\n\n", "export * from './b.ts';"),
    ).toBe("export * from './a.ts';\nexport * from './b.ts';\n");
  });

  it('adds nothing when the line is already there, whatever its indentation', () => {
    const text = "export * from './a.ts';\n";

    expect(appendLine(text, "  export * from './a.ts';")).toBe(text);
  });
});
