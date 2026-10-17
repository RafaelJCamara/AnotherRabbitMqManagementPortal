// UI copy lives in the i18n files (Transloco), where the honest-wording rule and the translation
// review can see it. A literal sentence in an Angular template skips both, so templates may only
// contain bindings, symbols and numbers. The rule checks text nodes, text inside interpolations
// (`Total: {{ n }}`), and the attributes that screen readers and tooltips read aloud.
import { defineRule, foreign, type ForeignNode } from '../utils.ts';

interface Options {
  /** Static attributes that carry user-visible text. */
  attributes?: string[];
  /** Elements whose text is code or data, not copy. */
  ignoreElements?: string[];
}

export const DEFAULT_ATTRIBUTES = [
  'title',
  'alt',
  'placeholder',
  'label',
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'summary',
];
export const DEFAULT_IGNORE_ELEMENTS = [
  'code',
  'kbd',
  'pre',
  'samp',
  'script',
  'style',
];

/** Letters in any script. Digits, punctuation and symbols alone are not copy. */
const HAS_LETTER = /\p{L}/u;

interface TextNode extends ForeignNode {
  value: string;
}
interface BoundTextNode extends ForeignNode {
  value: { ast?: { strings?: string[] } };
}
interface AttributeNode extends ForeignNode {
  name: string;
  value: unknown;
}
interface BoundAttributeNode extends ForeignNode {
  name: string;
  value: { ast?: { type?: string; value?: unknown } };
}
interface ElementNode extends ForeignNode {
  name?: string;
}

const hasLetter = (text: unknown): boolean =>
  typeof text === 'string' && HAS_LETTER.test(text);

export const uiNoRawTemplateText = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow literal user-facing text in Angular templates. Use the i18n files (Transloco).',
    },
    schema: [
      {
        type: 'object',
        properties: {
          attributes: { type: 'array', items: { type: 'string' } },
          ignoreElements: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      text: "Raw text '{{text}}' in a template. Move it to the i18n files and bind it with the transloco pipe.",
      attribute:
        "Raw text in '{{name}}'. Move it to the i18n files and bind it with the transloco pipe.",
    },
  },
  create(context) {
    const options = (context.options[0] ?? {}) as Options;
    const attributes = new Set(options.attributes ?? DEFAULT_ATTRIBUTES);
    const ignoreElements = new Set(
      options.ignoreElements ?? DEFAULT_IGNORE_ELEMENTS,
    );

    const insideIgnoredElement = (node: ForeignNode): boolean => {
      for (let parent = node.parent; parent; parent = parent.parent) {
        const { name } = parent as ElementNode;
        if (parent.type === 'Element' && name && ignoreElements.has(name)) {
          return true;
        }
      }
      return false;
    };
    const excerpt = (text: string) =>
      text.trim().replace(/\s+/g, ' ').slice(0, 40);

    return {
      Text: foreign<TextNode>((node) => {
        if (!hasLetter(node.value) || insideIgnoredElement(node)) return;
        context.report({
          node: node as never,
          messageId: 'text',
          data: { text: excerpt(node.value) },
        });
      }),

      // `Total: {{ count }} messages`: the static parts of an interpolation.
      BoundText: foreign<BoundTextNode>((node) => {
        if (insideIgnoredElement(node)) return;
        const raw = node.value.ast?.strings?.find((part) => hasLetter(part));
        if (raw === undefined) return;
        context.report({
          node: node as never,
          messageId: 'text',
          data: { text: excerpt(raw) },
        });
      }),

      TextAttribute: foreign<AttributeNode>((node) => {
        if (attributes.has(node.name) && hasLetter(node.value)) {
          context.report({
            node: node as never,
            messageId: 'attribute',
            data: { name: node.name },
          });
        }
      }),

      // `[title]="'Close'"`
      BoundAttribute: foreign<BoundAttributeNode>((node) => {
        const expression = node.value.ast;
        if (
          attributes.has(node.name) &&
          expression?.type === 'LiteralPrimitive' &&
          hasLetter(expression.value)
        ) {
          context.report({
            node: node as never,
            messageId: 'attribute',
            data: { name: node.name },
          });
        }
      }),
    };
  },
});
