// ADR-001: one engine bundle runs in three delivery modes (desktop, local, team). Mode files only
// swap adapters; services receive capabilities through ports and never ask which mode they run
// in. The config exempts the composition code (apps/engine entry, modes and modules).
import {
  defineRule,
  dottedPath,
  propertyName,
  stringValue,
  trailingName,
  type EsNode,
} from '../utils.ts';

const MODES = new Set(['desktop', 'local', 'team']);
const MODE_NAME = /mode/i;
const MODE_FLAG = /^is(?:desktop|local|team)(?:mode)?$/i;
const EQUALITY = new Set(['==', '===', '!=', '!==']);

const isModeLiteral = (node: EsNode): boolean => {
  const value = stringValue(node);
  return value !== null && MODES.has(value.toLowerCase());
};

/** `mode`, `config.deliveryMode`, `getMode()`. */
const isModeReference = (node: EsNode): boolean => {
  const name = trailingName(
    node.type === 'CallExpression' ? node.callee : node,
  );
  return name !== null && MODE_NAME.test(name);
};

/** `DeliveryMode.Desktop`, `Mode.team`. */
const isModeEnumMember = (node: EsNode): boolean => {
  if (node.type !== 'MemberExpression') return false;
  const path = dottedPath(node);
  const member = propertyName(node);
  const owner = path?.at(-2);
  return (
    owner !== undefined &&
    member !== null &&
    MODE_NAME.test(owner) &&
    MODES.has(member.toLowerCase())
  );
};

export const noModeBranching = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow branching on the delivery mode (desktop, local, team) outside the composition root (ADR-001).',
    },
    schema: [],
    messages: {
      branch:
        'Do not branch on the delivery mode in service code (ADR-001). Mode files swap adapters; services get capabilities through ports.',
    },
  },
  create(context) {
    return {
      BinaryExpression(node) {
        if (!EQUALITY.has(node.operator)) return;
        const { left, right } = node;
        if (left.type === 'PrivateIdentifier') return;
        if (
          (isModeLiteral(left) && isModeReference(right)) ||
          (isModeLiteral(right) && isModeReference(left)) ||
          isModeEnumMember(left) ||
          isModeEnumMember(right)
        ) {
          context.report({ node, messageId: 'branch' });
        }
      },

      SwitchStatement(node) {
        if (!isModeReference(node.discriminant)) return;
        const branchesOnMode = node.cases.some(
          (switchCase) =>
            switchCase.test !== null &&
            switchCase.test !== undefined &&
            (isModeLiteral(switchCase.test) ||
              isModeEnumMember(switchCase.test)),
        );
        if (branchesOnMode) {
          context.report({ node, messageId: 'branch' });
        }
      },

      CallExpression(node) {
        // `['desktop', 'local'].includes(mode)` and `isDesktop()` style probes.
        const { callee } = node;
        if (callee.type === 'Super') return;
        const name = trailingName(callee);
        if (name !== null && MODE_FLAG.test(name)) {
          context.report({ node, messageId: 'branch' });
          return;
        }
        if (
          callee.type === 'MemberExpression' &&
          name === 'includes' &&
          callee.object.type === 'ArrayExpression' &&
          callee.object.elements.some(
            (element) =>
              element !== null &&
              element.type !== 'SpreadElement' &&
              isModeLiteral(element),
          ) &&
          node.arguments.some(
            (argument) =>
              argument.type !== 'SpreadElement' && isModeReference(argument),
          )
        ) {
          context.report({ node, messageId: 'branch' });
        }
      },

      MemberExpression(node) {
        // `config.isDesktopMode` read as a flag.
        const name = propertyName(node);
        if (name !== null && MODE_FLAG.test(name)) {
          const parent = node.parent as EsNode;
          const isCalled =
            parent.type === 'CallExpression' && parent.callee === node;
          if (!isCalled) context.report({ node, messageId: 'branch' });
        }
      },
    };
  },
});
