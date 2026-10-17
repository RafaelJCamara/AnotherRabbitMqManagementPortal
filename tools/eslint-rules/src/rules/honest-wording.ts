// DC-15: honest wording. No CQ or QQ read is "non-destructive" or "read-only": every AMQP or HTTP
// read sets redelivered, moves counters or order and holds messages. The product says
// "side-effect-aware peek" and "messages stay in the queue". "Non-destructive" is reserved for
// anonymous stream browsing and the optional node-agent QQ peek.
//
// The rule runs on i18n JSON files (language `json/json` from @eslint/json) and on string
// literals in UI TypeScript:
//   - claim terms ("non-destructive", "without side effects", "safe peek", ...) are rejected under
//     every key except the allow-listed stream-browse and node-agent keys;
//   - "read-only" is a legitimate word for locks, permissions and managed-by status, so it is
//     rejected only under message-read contexts (messages.*, peek.*, dlq.*, mcp.tools.*) and not
//     under the allow-listed lock and permission keys (critique: honest-wording scope).
// Known limit: the term lists are English. Other locales need their own review (see
// docs/open-questions.md).
import {
  defineRule,
  foreign,
  type EsNode,
  type ForeignNode,
} from '../utils.ts';

interface Options {
  /** Keys where every term is allowed. Dot-separated, `*` is one segment, `**` is any number. */
  allowedKeys?: string[];
  /** Keys where "read-only" is allowed (locks, permissions, managed-by). */
  readOnlyAllowedKeys?: string[];
  /** Key prefixes that hold message-read copy; "read-only" is checked only here. */
  messageContexts?: string[];
}

export const DEFAULT_ALLOWED_KEYS = [
  '**.streamBrowse.**',
  '**.stream.browse.**',
  '**.streams.browse.**',
  '**.nodeAgent.**',
];
export const DEFAULT_READ_ONLY_ALLOWED_KEYS = [
  '**.lock.**',
  '**.locks.**',
  '**.permission.**',
  '**.permissions.**',
  '**.managedBy.**',
  '**.mcp.status.**',
];
export const DEFAULT_MESSAGE_CONTEXTS = [
  'messages',
  'peek',
  'dlq',
  'mcp.tools',
];

const CLAIM_TERMS: { label: string; pattern: RegExp }[] = [
  { label: 'non-destructive', pattern: /non[-\s]?destructive/i },
  {
    label: 'without side effects',
    pattern: /without (?:any )?side[-\s]effects?/i,
  },
  { label: 'side-effect-free', pattern: /side[-\s]effect[-\s]free/i },
  { label: 'safe peek', pattern: /\bsafe peek\b/i },
  { label: 'without breaking', pattern: /without breaking/i },
];
const READ_ONLY_TERM = { label: 'read-only', pattern: /\bread[-\s]?only\b/i };

/** `streamBrowse`, `stream-browse` and `stream_browse` are the same segment. */
const normalise = (segment: string): string =>
  segment.toLowerCase().replace(/[^a-z0-9*]/g, '');

const toSegments = (pattern: string): string[] =>
  pattern.split('.').map(normalise);

function matchSegments(path: string[], pattern: string[]): boolean {
  const [head, ...rest] = pattern;
  if (head === undefined) return path.length === 0;
  if (head === '**') {
    return (
      path.some((_, index) => matchSegments(path.slice(index), rest)) ||
      matchSegments([], rest)
    );
  }
  const [first, ...others] = path;
  if (first === undefined) return false;
  return (head === '*' || head === first) && matchSegments(others, rest);
}

const matchesAny = (path: string[], patterns: string[]): boolean => {
  const normalised = path.map(normalise);
  return patterns.some((pattern) =>
    matchSegments(normalised, toSegments(pattern)),
  );
};

/** True when the key path contains the context's segments as a contiguous run. */
function inContext(path: string[], contexts: string[]): boolean {
  return matchesAny(
    path,
    contexts.map((context) => `**.${context}.**`),
  );
}

interface JsonName extends ForeignNode {
  value?: string;
  name?: string;
}
interface JsonString extends ForeignNode {
  type: 'String';
  value: string;
}
interface JsonMember extends ForeignNode {
  name: JsonName;
  value: ForeignNode;
}
interface JsonElement extends ForeignNode {
  value: ForeignNode;
}

export const honestWording = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Reject "non-destructive", "read-only" and similar claims about message reads outside the allow-listed keys (DC-15).',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowedKeys: { type: 'array', items: { type: 'string' } },
          readOnlyAllowedKeys: { type: 'array', items: { type: 'string' } },
          messageContexts: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      claim:
        "'{{term}}' overstates what a message read does (DC-15). Say 'side-effect-aware peek' and 'messages stay in the queue'. The word is reserved for the stream-browse and node-agent keys.",
      readOnly:
        "'read-only' must not describe a message read (DC-15). It is allowed only for lock, permission and managed-by keys.",
      claimInCode:
        "'{{term}}' overstates what a message read does (DC-15). Put UI copy in the i18n files, where the stream-browse and node-agent keys may use it.",
    },
  },
  create(context) {
    const options = (context.options[0] ?? {}) as Options;
    const allowedKeys = options.allowedKeys ?? DEFAULT_ALLOWED_KEYS;
    const readOnlyAllowedKeys =
      options.readOnlyAllowedKeys ?? DEFAULT_READ_ONLY_ALLOWED_KEYS;
    const messageContexts = options.messageContexts ?? DEFAULT_MESSAGE_CONTEXTS;

    // ---- i18n JSON -----------------------------------------------------------------------
    const keyPath: string[] = [];

    const checkJsonString = (node: ForeignNode) => {
      if (node.type !== 'String') return;
      const text = (node as JsonString).value;
      if (matchesAny(keyPath, allowedKeys)) return;

      const claim = CLAIM_TERMS.find(({ pattern }) => pattern.test(text));
      if (claim) {
        context.report({
          node: node as never,
          messageId: 'claim',
          data: { term: claim.label },
        });
        return;
      }
      if (
        READ_ONLY_TERM.pattern.test(text) &&
        inContext(keyPath, messageContexts) &&
        !matchesAny(keyPath, readOnlyAllowedKeys)
      ) {
        context.report({ node: node as never, messageId: 'readOnly' });
      }
    };

    // ---- TypeScript string literals --------------------------------------------------------
    const checkCode = (node: EsNode, text: string) => {
      const claim = CLAIM_TERMS.find(({ pattern }) => pattern.test(text));
      if (claim) {
        context.report({
          node,
          messageId: 'claimInCode',
          data: { term: claim.label },
        });
      }
    };

    return {
      Member: foreign<JsonMember>((node) => {
        const name = node.name.value ?? node.name.name ?? '';
        keyPath.push(name);
        checkJsonString(node.value);
      }),
      'Member:exit': () => {
        keyPath.pop();
      },
      Element: foreign<JsonElement>((node) => {
        checkJsonString(node.value);
      }),

      Literal(node) {
        if (typeof node.value !== 'string') return;
        const parent = node.parent as EsNode;
        if (
          parent.type === 'ImportDeclaration' ||
          parent.type === 'ExportNamedDeclaration' ||
          parent.type === 'ExportAllDeclaration'
        ) {
          return;
        }
        checkCode(node, node.value);
      },
      TemplateElement(node) {
        checkCode(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
});
