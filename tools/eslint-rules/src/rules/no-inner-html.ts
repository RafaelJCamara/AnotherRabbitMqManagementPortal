// ADR-021 / blueprint 8.x: innerHTML is banned. Message bodies and decoded payloads are untrusted
// text and are rendered through Angular bindings only. The rule covers TypeScript (property
// writes, insertAdjacentHTML, document.write, sanitizer bypasses, Renderer2.setProperty,
// host bindings) and Angular templates ([innerHTML] and [outerHTML]).
import {
  defineRule,
  dottedPath,
  foreign,
  propertyName,
  stringValue,
  trailingName,
  type EsNode,
  type ForeignNode,
} from '../utils.ts';

const HTML_PROPERTIES = new Set(['innerHTML', 'outerHTML']);
const HTML_METHODS = new Set([
  'insertAdjacentHTML',
  'setHTMLUnsafe',
  'createContextualFragment',
  'bypassSecurityTrustHtml',
]);
const DOCUMENT_WRITERS = new Set(['write', 'writeln']);

interface TemplateAttribute extends ForeignNode {
  name: string;
}

export const noInnerHtml = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow innerHTML and the other ways to put markup into the DOM. Render untrusted text through Angular bindings.',
    },
    schema: [],
    messages: {
      property:
        "Do not use '{{name}}': untrusted text is rendered through Angular bindings only (ADR-021).",
      method: "Do not call '{{name}}': it puts markup into the DOM (ADR-021).",
      template:
        "Do not bind '{{name}}' in a template: untrusted text is rendered through interpolation (ADR-021).",
    },
  },
  create(context) {
    return {
      // el.innerHTML = x, el['outerHTML'] += x
      AssignmentExpression(node) {
        const { left } = node;
        if (left.type !== 'MemberExpression') return;
        const name = propertyName(left);
        if (name !== null && HTML_PROPERTIES.has(name)) {
          context.report({ node, messageId: 'property', data: { name } });
        }
      },

      // const { innerHTML } = el is a read; the write forms are the ones that matter. Object
      // literals reach the DOM through Renderer2.setProperty(el, 'innerHTML', x) and Angular host
      // bindings ({ '[innerHTML]': 'x' }).
      Property(node) {
        const parent = node.parent as EsNode;
        if (parent.type !== 'ObjectExpression') return;
        const key = node.computed
          ? stringValue(node.key)
          : node.key.type === 'Identifier'
            ? node.key.name
            : stringValue(node.key);
        if (key === null) return;
        const bare = key.replace(/^\[(.*)\]$/, '$1');
        if (bare !== key && HTML_PROPERTIES.has(bare)) {
          context.report({ node, messageId: 'property', data: { name: key } });
        }
      },

      CallExpression(node) {
        const { callee } = node;
        if (callee.type === 'Super') return;
        const name = trailingName(callee);
        if (name === null) return;

        if (HTML_METHODS.has(name)) {
          context.report({ node, messageId: 'method', data: { name } });
          return;
        }
        // document.write(...) / document.writeln(...)
        const path = dottedPath(callee);
        if (
          path !== null &&
          path.length === 2 &&
          path[0] === 'document' &&
          DOCUMENT_WRITERS.has(name)
        ) {
          context.report({
            node,
            messageId: 'method',
            data: { name: `document.${name}` },
          });
          return;
        }
        // renderer.setProperty(el, 'innerHTML', x)
        if (name === 'setProperty') {
          const target = node.arguments[1];
          const property =
            target && target.type !== 'SpreadElement'
              ? stringValue(target)
              : null;
          if (property !== null && HTML_PROPERTIES.has(property)) {
            context.report({
              node,
              messageId: 'property',
              data: { name: property },
            });
          }
        }
      },

      // Angular templates: <div [innerHTML]="x">
      BoundAttribute: foreign<TemplateAttribute>((node) => {
        if (HTML_PROPERTIES.has(node.name)) {
          context.report({
            node: node as never,
            messageId: 'template',
            data: { name: node.name },
          });
        }
      }),
    };
  },
});
