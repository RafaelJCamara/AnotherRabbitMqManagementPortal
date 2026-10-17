// Helpers shared by the rules. The rules are written against the ESTree shape (and the
// typescript-eslint, Angular template and JSON node shapes where a rule needs them) and never
// import the library whose misuse they detect, so they work before that library is installed.
import type { AST, Rule, SourceCode } from 'eslint';

/** Any ESTree node, without the `parent` link ESLint adds. */
export type EsNode = Exclude<
  NonNullable<Parameters<SourceCode['getText']>[0]>,
  AST.Token
>;
export type EsNodeOf<T extends EsNode['type']> = Extract<EsNode, { type: T }>;

/** Builds a rule with the metadata every rule in this plugin shares. */
export function defineRule(rule: Rule.RuleModule): Rule.RuleModule {
  return rule;
}

/** A node shape owned by another parser (Angular templates, JSON, typescript-eslint). */
export interface ForeignNode {
  type: string;
  parent?: ForeignNode;
  loc?: unknown;
  [key: string]: unknown;
}

/**
 * Registers a handler for a node type the ESTree typings do not know about (Angular template
 * nodes, JSON nodes). ESLint only calls it when the active parser produces that node type.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T is the caller's statement of which node shape the parser produces.
export function foreign<T extends ForeignNode>(
  handler: (node: T) => void,
): (node: Rule.Node) => void {
  return (node) => {
    handler(node as unknown as T);
  };
}

/** The value of a string literal or of a template literal without expressions. */
export function stringValue(node: EsNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === 'Literal') {
    return typeof node.value === 'string' ? node.value : null;
  }
  if (
    node.type === 'TemplateLiteral' &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

/** The static name of a property access: `a.b` and `a['b']` both give `b`. */
export function propertyName(
  node: EsNodeOf<'MemberExpression'>,
): string | null {
  if (!node.computed) {
    return node.property.type === 'Identifier' ? node.property.name : null;
  }
  return stringValue(node.property);
}

/** The name a call or reference ends in: `f` for `f()`, `g` for `a.g()`. */
export function trailingName(node: EsNode): string | null {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression') return propertyName(node);
  return null;
}

/** `a.b.c` as `['a', 'b', 'c']`; null when any part is not a plain name. */
export function dottedPath(node: EsNode): string[] | null {
  if (node.type === 'Identifier') return [node.name];
  if (node.type === 'ThisExpression') return ['this'];
  if (node.type === 'MemberExpression') {
    const name = propertyName(node);
    const head = dottedPath(node.object);
    return name !== null && head ? [...head, name] : null;
  }
  return null;
}

/** Unwraps `x!`, `x as T` and `<T>x`, which do not change what the expression is. */
export function unwrap(node: EsNode): EsNode {
  let current: EsNode = node;
  for (;;) {
    const type = current.type as string;
    if (
      type === 'TSNonNullExpression' ||
      type === 'TSAsExpression' ||
      type === 'TSSatisfiesExpression' ||
      type === 'TSTypeAssertion' ||
      type === 'ChainExpression'
    ) {
      const inner = (current as unknown as { expression?: EsNode }).expression;
      if (!inner) return current;
      current = inner;
    } else {
      return current;
    }
  }
}
