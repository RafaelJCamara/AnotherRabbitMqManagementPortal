// UI rule: all engine traffic goes through Angular's HttpClient (EngineApi, with the correlation,
// auth and problem interceptors) and the LiveChannel. On desktop the HttpBackend is replaced by the
// MessagePort transport, so a direct `fetch` would bypass the transport and the interceptors and
// break in the desktop host. The config exempts libs/ui/platform, which owns the transports.
import { defineRule, propertyName, type EsNode } from '../utils.ts';

const GLOBAL_CLIENTS = new Set([
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
]);
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self']);

export const noDirectFetch = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow fetch, XMLHttpRequest, WebSocket, EventSource and sendBeacon in UI code. Use EngineApi (HttpClient) and the LiveChannel.',
    },
    schema: [],
    messages: {
      direct:
        "Do not use '{{name}}' directly. Go through EngineApi (HttpClient) or the LiveChannel so the transport, interceptors and the desktop MessagePort apply.",
    },
  },
  create(context) {
    const { sourceCode } = context;

    return {
      'Program:exit'(program) {
        // References to globals that nothing in the file shadows.
        const globalScope = sourceCode.getScope(program);
        const unresolved = [
          ...globalScope.through,
          ...globalScope.variables
            .filter((variable) => variable.defs.length === 0)
            .flatMap((variable) => variable.references),
        ];
        for (const reference of unresolved) {
          const { name } = reference.identifier;
          if (!GLOBAL_CLIENTS.has(name)) continue;
          // Type positions (`socket: WebSocket`, `typeof fetch`) and `typeof fetch` checks
          // are not uses of the client.
          const parent = (reference.identifier as EsNode & { parent?: EsNode })
            .parent;
          if (
            parent?.type.startsWith('TS') ||
            (parent?.type === 'UnaryExpression' && parent.operator === 'typeof')
          ) {
            continue;
          }
          context.report({
            node: reference.identifier,
            messageId: 'direct',
            data: { name },
          });
        }
      },

      // window.fetch, globalThis.fetch, self.fetch, navigator.sendBeacon
      MemberExpression(node) {
        if (node.object.type !== 'Identifier') return;
        const name = propertyName(node);
        if (name === null) return;
        const owner = node.object.name;
        const isGlobalClient =
          GLOBAL_OBJECTS.has(owner) && GLOBAL_CLIENTS.has(name);
        const isBeacon = owner === 'navigator' && name === 'sendBeacon';
        if (isGlobalClient || isBeacon) {
          context.report({
            node,
            messageId: 'direct',
            data: { name: `${owner}.${name}` },
          });
        }
      },
    };
  },
});
