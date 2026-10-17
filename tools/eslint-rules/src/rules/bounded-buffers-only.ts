// I-6: every buffer is bounded by item count and by bytes, and every drop is counted. Engine code
// buffers through BoundedRing and BoundedQueue (libs/engine/kernel/src/bounded) and nothing else.
// Static analysis cannot see intent, so the rule goes by the name: a variable, property or field
// whose name says it is a buffer must not be a plain array, Map or Set, and nothing may push onto
// it. Names that mean broker entities (`queue`, `queues`) are deliberately not matched.
import type { Rule } from 'eslint';

import { defineRule, dottedPath, unwrap, type EsNode } from '../utils.ts';

const BUFFER_NAME = /(?:buffer|buf|backlog|outbox|inbox|ring|fifo|deque)s?$/i;
const UNBOUNDED_CLASSES = new Set(['Array', 'Map', 'Set']);
const GROWING_METHODS = new Set(['push', 'unshift']);

/** The name a declaration or assignment target introduces. */
function targetName(node: EsNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression') return dottedPath(node)?.at(-1) ?? null;
  return null;
}

function isUnboundedInitialiser(node: EsNode | null | undefined): boolean {
  if (!node) return false;
  const value = unwrap(node);
  if (value.type === 'ArrayExpression') return true;
  if (value.type === 'NewExpression') {
    return (
      value.callee.type === 'Identifier' &&
      UNBOUNDED_CLASSES.has(value.callee.name)
    );
  }
  if (value.type === 'CallExpression') {
    const path = dottedPath(value.callee);
    return path?.join('.') === 'Array.from' || path?.join('.') === 'Array.of';
  }
  return false;
}

export const boundedBuffersOnly = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require BoundedRing or BoundedQueue for buffers (I-6): no plain arrays, Maps or Sets named as buffers.',
    },
    schema: [],
    messages: {
      unbounded:
        "'{{name}}' looks like a buffer but is an unbounded collection. Use BoundedRing or BoundedQueue, bounded by items and bytes with counted drops (I-6).",
      grow: "Do not push onto '{{name}}': buffers must be BoundedRing or BoundedQueue, bounded by items and bytes with counted drops (I-6).",
    },
  },
  create(context) {
    const check = (
      node: Rule.Node,
      name: string | null,
      initialiser: EsNode | null | undefined,
    ) => {
      if (
        name !== null &&
        BUFFER_NAME.test(name) &&
        isUnboundedInitialiser(initialiser)
      ) {
        context.report({ node, messageId: 'unbounded', data: { name } });
      }
    };

    return {
      VariableDeclarator(node) {
        check(node, targetName(node.id), node.init);
      },
      PropertyDefinition(node) {
        check(node, targetName(node.key), node.value);
      },
      AssignmentExpression(node) {
        if (node.operator === '=') {
          check(node, targetName(node.left), node.right);
        }
      },
      CallExpression(node) {
        const { callee } = node;
        if (callee.type !== 'MemberExpression') return;
        const method = callee.computed
          ? null
          : callee.property.type === 'Identifier'
            ? callee.property.name
            : null;
        if (method === null || !GROWING_METHODS.has(method)) return;
        const name = targetName(callee.object);
        if (name !== null && BUFFER_NAME.test(name)) {
          context.report({ node, messageId: 'grow', data: { name } });
        }
      },
    };
  },
});
