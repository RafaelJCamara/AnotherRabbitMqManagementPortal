// What a source file mentions, read from its syntax tree (the TypeScript compiler API; no type
// information is needed, so a rule runs on any file without building the program).
import ts from 'typescript';

export interface FileFacts {
  /** Names bound by imports, whatever the module (`import { A as B }` yields `A`). */
  importedNames: Set<string>;
  /** Every identifier that is a type reference, a value or a member name. */
  identifiers: Set<string>;
  /** Property names read from an object (ctx.writes) or destructured from one ({ writes }). */
  members: Set<string>;
  /** Names called as a function (`f()` and `x.f()` both give `f`). */
  calls: Map<string, number>;
  /** Target types of `as T` and `<T>x` assertions. */
  assertedTypes: Set<string>;
  /** The module of every `import`, `export ... from`, `import('x')` and `require('x')`. */
  moduleSpecifiers: Set<string>;
}

function calleeName(expression: ts.LeftHandSideExpression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function typeName(type: ts.TypeNode): string | undefined {
  if (!ts.isTypeReferenceNode(type)) return undefined;
  const { typeName: name } = type;
  return ts.isIdentifier(name) ? name.text : name.right.text;
}

export function readFacts(path: string, text: string): FileFacts {
  const file = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const facts: FileFacts = {
    importedNames: new Set(),
    identifiers: new Set(),
    members: new Set(),
    calls: new Map(),
    assertedTypes: new Set(),
    moduleSpecifiers: new Set(),
  };

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      facts.moduleSpecifiers.add(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require')) &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      facts.moduleSpecifiers.add(node.arguments[0].text);
    } else if (ts.isImportTypeNode(node)) {
      const { argument } = node;
      if (
        ts.isLiteralTypeNode(argument) &&
        ts.isStringLiteral(argument.literal)
      ) {
        facts.moduleSpecifiers.add(argument.literal.text);
      }
    }
    if (ts.isImportSpecifier(node)) {
      facts.importedNames.add((node.propertyName ?? node.name).text);
    } else if (ts.isIdentifier(node)) {
      facts.identifiers.add(node.text);
    } else if (ts.isPropertyAccessExpression(node)) {
      facts.members.add(node.name.text);
    } else if (
      ts.isBindingElement(node) &&
      ts.isObjectBindingPattern(node.parent)
    ) {
      const name = node.propertyName ?? node.name;
      if (ts.isIdentifier(name)) facts.members.add(name.text);
    } else if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name !== undefined) {
        facts.calls.set(name, (facts.calls.get(name) ?? 0) + 1);
      }
    } else if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      const name = typeName(node.type);
      if (name !== undefined) facts.assertedTypes.add(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return facts;
}
