// Small, syntax-aware edits of existing source files (eslint.config.mjs, registries). The
// generators parse the file with the TypeScript compiler and splice text at the node positions, so
// a changed layout or a comment next to the target cannot confuse them the way a regular
// expression could. Prettier runs afterwards (Writer.flush).
import ts from 'typescript';

function parse(text: string, fileName: string): ts.SourceFile {
  const kind = /\.(?:ts|mts|cts)$/.test(fileName)
    ? ts.ScriptKind.TS
    : ts.ScriptKind.JS;
  return ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** The array literal assigned to the top-level variable `name`. */
export function findArray(
  source: ts.SourceFile,
  name: string,
): ts.ArrayLiteralExpression {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer
      ) {
        const value = unwrap(declaration.initializer);
        if (ts.isArrayLiteralExpression(value)) return value;
      }
    }
  }
  throw new Error(
    `${source.fileName}: no top-level array named "${name}". The generator expects it; was the file restructured?`,
  );
}

/** The array assigned to `property` of the object literal that the top-level `name` holds. */
export function findPropertyArray(
  source: ts.SourceFile,
  name: string,
  property: string,
): ts.ArrayLiteralExpression {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== name ||
        !declaration.initializer
      ) {
        continue;
      }
      const value = unwrap(declaration.initializer);
      if (!ts.isObjectLiteralExpression(value)) continue;
      for (const member of value.properties) {
        if (
          ts.isPropertyAssignment(member) &&
          ts.isIdentifier(member.name) &&
          member.name.text === property
        ) {
          const array = unwrap(member.initializer);
          if (ts.isArrayLiteralExpression(array)) return array;
        }
      }
    }
  }
  throw new Error(
    `${source.fileName}: no top-level object "${name}" with an array property "${property}". The generator expects it; was the file restructured?`,
  );
}

function splice(
  text: string,
  array: ts.ArrayLiteralExpression,
  element: string,
): string {
  const close = array.getEnd() - 1;
  const before = text.slice(0, close).trimEnd();
  const comma = array.elements.length > 0 && !before.endsWith(',') ? ',' : '';
  return `${before}${comma}\n${element},\n${text.slice(close)}`;
}

/** Appends `element` (source text) as the last item of the array `name`. */
export function appendToArray(
  text: string,
  fileName: string,
  name: string,
  element: string,
): string {
  return splice(text, findArray(parse(text, fileName), name), element);
}

/** Appends `element` as the last item of the array `property` of the object `name`. */
export function appendToPropertyArray(
  text: string,
  fileName: string,
  name: string,
  property: string,
  element: string,
): string {
  return splice(
    text,
    findPropertyArray(parse(text, fileName), name, property),
    element,
  );
}

/** Adds `line` at the end of the file; a no-op when the file already holds it. */
export function appendLine(text: string, line: string): string {
  if (text.split('\n').some((existing) => existing.trim() === line.trim())) {
    return text;
  }
  return `${text.replace(/\s*$/, '')}\n${line}\n`;
}

/** The elements of the array `name` as source text. */
export function arrayElements(
  text: string,
  fileName: string,
  name: string,
): string[] {
  const source = parse(text, fileName);
  return findArray(source, name).elements.map((element) =>
    element.getText(source),
  );
}

function stringsOf(expression: ts.Expression | undefined): string[] {
  if (!expression) return [];
  const value = unwrap(expression);
  if (!ts.isArrayLiteralExpression(value)) return [];
  return value.elements.flatMap((element) =>
    ts.isStringLiteralLike(element) ? [element.text] : [],
  );
}

/** String-array properties of an object literal element, by property name. */
export type ObjectStrings = Record<string, string[]>;

/** For an array of object literals, the string-array properties of each object. */
export function arrayOfObjects(
  text: string,
  fileName: string,
  name: string,
): ObjectStrings[] {
  const source = parse(text, fileName);
  return findArray(source, name).elements.flatMap((element) => {
    if (!ts.isObjectLiteralExpression(element)) return [];
    const result: ObjectStrings = {};
    for (const property of element.properties) {
      if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
        result[property.name.text] = stringsOf(property.initializer);
      }
    }
    return [result];
  });
}

/** Adds an import after the last top-level import; a no-op when the line is already there. */
export function appendImport(
  text: string,
  fileName: string,
  importLine: string,
): string {
  if (text.includes(importLine)) return text;
  const source = parse(text, fileName);
  const imports = source.statements.filter(ts.isImportDeclaration);
  const last = imports.at(-1);
  if (!last) return `${importLine}\n${text}`;
  const end = last.getEnd();
  return `${text.slice(0, end)}\n${importLine}${text.slice(end)}`;
}
