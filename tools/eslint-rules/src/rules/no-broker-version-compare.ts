// I-3 / DC-01: version-dependent broker behaviour is data in the semantics registry, never a
// comparison in code. The rule finds version literals in comparisons, version-compare calls and
// `semver` helpers. The config scopes it to everything except the registry and svc-capabilities.
import {
  defineRule,
  propertyName,
  stringValue,
  trailingName,
  type EsNode,
} from '../utils.ts';

/** `4.3.0`, `v4.3`, `>=4.3.0`, `4.x`, `4.3.0-rc.1`. */
const VERSION_LITERAL =
  /^[<>=~^v\s]*\d+\.(?:\d+|x|\*)(?:\.(?:\d+|x|\*))?(?:[-+][0-9A-Za-z.+-]+)?$/;

const COMPARISON_OPERATORS = new Set([
  '<',
  '<=',
  '>',
  '>=',
  '==',
  '===',
  '!=',
  '!==',
]);

/** Function and method names that compare versions. */
const COMPARATORS = new Set([
  'gt',
  'gte',
  'lt',
  'lte',
  'eq',
  'neq',
  'cmp',
  'compare',
  'compareBuild',
  'compareLoose',
  'satisfies',
  'intersects',
  'subset',
  'localeCompare',
]);
const COMPARATOR_PATTERN = /compare.*versions?|versions?.*compare/i;

const VERSION_PARTS = new Set(['major', 'minor', 'patch']);

const isVersionLiteral = (node: EsNode): boolean => {
  const value = stringValue(node);
  return value !== null && VERSION_LITERAL.test(value.trim());
};

const isNumberLiteral = (node: EsNode): boolean =>
  node.type === 'Literal' && typeof node.value === 'number';

const isVersionPart = (node: EsNode): boolean =>
  node.type === 'MemberExpression' &&
  VERSION_PARTS.has(propertyName(node) ?? '');

export const noBrokerVersionCompare = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow comparing broker versions in code (I-3, DC-01). Version-dependent behaviour is data in the semantics registry.',
    },
    schema: [],
    messages: {
      compare:
        'Do not compare broker versions in code (I-3, DC-01). Add a cell to the semantics registry (libs/shared/semantics) or read a gate from svc-capabilities.',
    },
  },
  create(context) {
    // Local names bound to the `semver` package: bare functions and namespace objects.
    const semverFunctions = new Set<string>();
    const semverNamespaces = new Set<string>();

    return {
      ImportDeclaration(node) {
        const source = String(node.source.value);
        if (source !== 'semver' && !source.startsWith('semver/')) return;
        for (const specifier of node.specifiers) {
          if (specifier.type === 'ImportSpecifier') {
            const imported =
              specifier.imported.type === 'Identifier'
                ? specifier.imported.name
                : String(specifier.imported.value);
            if (COMPARATORS.has(imported) || imported === 'default') {
              semverFunctions.add(specifier.local.name);
            }
          } else if (source === 'semver') {
            semverNamespaces.add(specifier.local.name);
          } else {
            // `import gte from 'semver/functions/gte'`
            semverFunctions.add(specifier.local.name);
          }
        }
      },

      BinaryExpression(node) {
        if (!COMPARISON_OPERATORS.has(node.operator)) return;
        const { left, right } = node;
        if (left.type === 'PrivateIdentifier') return;
        if (isVersionLiteral(left) || isVersionLiteral(right)) {
          context.report({ node, messageId: 'compare' });
        } else if (
          (isVersionPart(left) && isNumberLiteral(right)) ||
          (isVersionPart(right) && isNumberLiteral(left))
        ) {
          context.report({ node, messageId: 'compare' });
        }
      },

      CallExpression(node) {
        const { callee } = node;
        if (callee.type === 'Super') return;
        const name = trailingName(callee);
        if (name === null) return;

        const viaSemver =
          (callee.type === 'Identifier' && semverFunctions.has(name)) ||
          (callee.type === 'MemberExpression' &&
            callee.object.type === 'Identifier' &&
            semverNamespaces.has(callee.object.name) &&
            COMPARATORS.has(name));
        const comparator =
          COMPARATORS.has(name) || COMPARATOR_PATTERN.test(name);
        const hasVersionArgument = node.arguments.some(
          (argument) =>
            argument.type !== 'SpreadElement' && isVersionLiteral(argument),
        );

        if (viaSemver || (comparator && hasVersionArgument)) {
          context.report({ node, messageId: 'compare' });
        }
      },
    };
  },
});
