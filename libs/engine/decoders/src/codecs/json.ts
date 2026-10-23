// JSON: an iterative validator and pretty printer (no recursion, so depth cannot overflow the
// stack), with depth, node and view limits. The pretty text keeps number lexemes as written
// (`12345678901234567890` stays exact); the tree comes from JSON.parse and only when the document
// is within the limits. A `__proto__` key is an ordinary own key.
import { decodeText } from './charset.ts';
import { fail } from './errors.ts';
import type {
  CodecNote,
  FormatCodec,
  FormatOutput,
  JsonValue,
  Truncation,
} from './types.ts';
import { fitUtf8 } from './views.ts';

const CH_QUOTE = 0x22;
const CH_COMMA = 0x2c;
const CH_COLON = 0x3a;
const CH_OPEN_BRACKET = 0x5b;
const CH_CLOSE_BRACKET = 0x5d;
const CH_OPEN_BRACE = 0x7b;
const CH_CLOSE_BRACE = 0x7d;

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const INDENTS: string[] = [];
for (let depth = 0; depth <= 65; depth++) {
  INDENTS.push(`\n${'  '.repeat(depth)}`);
}

function skipWhitespace(text: string, from: number): number {
  let at = from;
  for (;;) {
    const code = text.charCodeAt(at);
    if (code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09) {
      at++;
    } else {
      return at;
    }
  }
}

/** The index after the string that starts at `from` (a quote). */
function endOfString(text: string, from: number): number {
  const n = text.length;
  let at = from + 1;
  for (; at < n; at++) {
    const code = text.charCodeAt(at);
    if (code === CH_QUOTE) return at + 1;
    if (code < 0x20) return fail('MALFORMED_JSON', at);
    if (code === 0x5c) {
      at++;
      const escape = text.charCodeAt(at);
      // " \ / b f n r t
      if (
        escape === 0x22 ||
        escape === 0x5c ||
        escape === 0x2f ||
        escape === 0x62 ||
        escape === 0x66 ||
        escape === 0x6e ||
        escape === 0x72 ||
        escape === 0x74
      ) {
        continue;
      }
      if (escape === 0x75) {
        for (let k = 1; k <= 4; k++) {
          const hex = text.charCodeAt(at + k);
          const isHex =
            (hex >= 0x30 && hex <= 0x39) ||
            (hex >= 0x41 && hex <= 0x46) ||
            (hex >= 0x61 && hex <= 0x66);
          if (!isHex) return fail('MALFORMED_JSON', at + k);
        }
        at += 4;
        continue;
      }
      return fail('MALFORMED_JSON', at);
    }
  }
  return fail('MALFORMED_JSON', n);
}

function literalLength(text: string, from: number): number {
  NUMBER.lastIndex = from;
  const match = NUMBER.exec(text);
  if (match !== null) return match[0].length;
  if (text.startsWith('true', from) || text.startsWith('null', from)) return 4;
  if (text.startsWith('false', from)) return 5;
  return fail('MALFORMED_JSON', from);
}

interface Scan {
  readonly pretty: string;
  readonly nodes: number;
  readonly stopped: 'depth' | 'nodes' | 'view' | null;
  /** The characters of the input not read when the scan stopped. */
  readonly unread: number;
}

const MODE_VALUE = 0;
const MODE_AFTER = 1;
const MODE_KEY = 2;
const MODE_ARRAY_FIRST = 3;
const MODE_KEY_FIRST = 4;

export function scanJson(
  text: string,
  maxDepth: number,
  maxNodes: number,
  maxChars: number,
): Scan {
  const n = text.length;
  const parts: string[] = [];
  const open: number[] = [];
  let length = 0;
  let nodes = 0;
  let at = 0;
  let mode: number = MODE_VALUE;
  const emit = (piece: string): void => {
    parts.push(piece);
    length += piece.length;
  };
  const stop = (stopped: 'depth' | 'nodes' | 'view'): Scan => ({
    pretty: parts.join(''),
    nodes,
    stopped,
    unread: n - at,
  });

  for (;;) {
    at = skipWhitespace(text, at);
    if (length > maxChars) return stop('view');
    if (at >= n) {
      if (mode === MODE_AFTER && open.length === 0) break;
      return fail('MALFORMED_JSON', at);
    }
    const code = text.charCodeAt(at);

    if (mode === MODE_AFTER) {
      const top = open[open.length - 1];
      if (top === undefined) return fail('MALFORMED_JSON', at);
      if (code === CH_COMMA) {
        at++;
        emit(`,${INDENTS[open.length] ?? '\n'}`);
        mode = top === CH_OPEN_BRACE ? MODE_KEY : MODE_VALUE;
      } else if (
        (code === CH_CLOSE_BRACE && top === CH_OPEN_BRACE) ||
        (code === CH_CLOSE_BRACKET && top === CH_OPEN_BRACKET)
      ) {
        open.pop();
        at++;
        emit(`${INDENTS[open.length] ?? '\n'}${String.fromCharCode(code)}`);
      } else {
        return fail('MALFORMED_JSON', at);
      }
      continue;
    }

    if (mode === MODE_KEY_FIRST) {
      if (code === CH_CLOSE_BRACE) {
        open.pop();
        at++;
        emit('}');
        mode = MODE_AFTER;
        continue;
      }
      emit(INDENTS[open.length] ?? '\n');
      mode = MODE_KEY;
    } else if (mode === MODE_ARRAY_FIRST) {
      if (code === CH_CLOSE_BRACKET) {
        open.pop();
        at++;
        emit(']');
        mode = MODE_AFTER;
        continue;
      }
      emit(INDENTS[open.length] ?? '\n');
      mode = MODE_VALUE;
    }

    if (mode === MODE_KEY) {
      if (code !== CH_QUOTE) return fail('MALFORMED_JSON', at);
      const end = endOfString(text, at);
      emit(text.slice(at, end));
      nodes++;
      at = skipWhitespace(text, end);
      if (text.charCodeAt(at) !== CH_COLON) return fail('MALFORMED_JSON', at);
      at++;
      emit(': ');
      mode = MODE_VALUE;
      continue;
    }

    // A value is expected.
    if (nodes >= maxNodes) return stop('nodes');
    if (code === CH_OPEN_BRACE || code === CH_OPEN_BRACKET) {
      if (open.length >= maxDepth) return stop('depth');
      open.push(code);
      nodes++;
      at++;
      emit(code === CH_OPEN_BRACE ? '{' : '[');
      mode = code === CH_OPEN_BRACE ? MODE_KEY_FIRST : MODE_ARRAY_FIRST;
    } else if (code === CH_QUOTE) {
      const end = endOfString(text, at);
      emit(text.slice(at, end));
      nodes++;
      at = end;
      mode = MODE_AFTER;
    } else {
      const size = literalLength(text, at);
      emit(text.slice(at, at + size));
      nodes++;
      at += size;
      mode = MODE_AFTER;
    }
  }
  return { pretty: parts.join(''), nodes, stopped: null, unread: 0 };
}

export const jsonCodec: FormatCodec = {
  kind: 'format',
  id: 'json',
  mimes: ['application/json', 'text/json', 'application/x-json', '+json'],
  detect(sample) {
    let at =
      sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf ? 3 : 0;
    const skip = (): void => {
      while (
        sample[at] === 0x20 ||
        sample[at] === 0x0a ||
        sample[at] === 0x0d ||
        sample[at] === 0x09
      ) {
        at++;
      }
    };
    skip();
    const first = sample[at];
    if (first !== CH_OPEN_BRACE && first !== CH_OPEN_BRACKET) return 0;
    at++;
    skip();
    const second = sample[at];
    if (first === CH_OPEN_BRACE) {
      return second === CH_QUOTE || second === CH_CLOSE_BRACE ? 0.8 : 0.5;
    }
    return second === CH_OPEN_BRACE ||
      second === CH_QUOTE ||
      second === CH_OPEN_BRACKET ||
      second === CH_CLOSE_BRACKET ||
      (second !== undefined && second >= 0x30 && second <= 0x39)
      ? 0.7
      : 0.4;
  },
  decode(bytes, context): FormatOutput {
    const { limits } = context;
    const decoded = decodeText(bytes, {
      declared: context.charset,
      maxBytes: limits.maxInputBytes,
      lossy: false,
    });
    const source = decoded.text;
    const scan = scanJson(
      source,
      limits.maxDepth,
      limits.maxNodes,
      limits.maxViewBytes,
    );
    const truncations: Truncation[] = [];
    const notes: CodecNote[] = [];
    if (scan.stopped === null) {
      let value: JsonValue;
      try {
        value = JSON.parse(source) as JsonValue;
      } catch {
        return fail('MALFORMED_JSON');
      }
      const fitted = fitUtf8(scan.pretty, limits.maxViewBytes);
      if (fitted.cutChars === 0) {
        return {
          view: { kind: 'tree', value, text: fitted.text },
          type: 'json',
          mime: 'application/json',
          truncations,
          notes,
        };
      }
      truncations.push({
        what: 'view',
        max: limits.maxViewBytes,
        dropped: fitted.cutChars,
      });
      return {
        view: { kind: 'text', text: fitted.text, charset: 'utf-8' },
        type: 'json',
        mime: 'application/json',
        truncations,
        notes,
      };
    }
    // A limit stopped the scan: the document may be valid or not beyond that point, so the view
    // is text, the tree is dropped, and the limit is counted (I-13).
    if (scan.stopped === 'depth') {
      truncations.push({ what: 'depth', max: limits.maxDepth, dropped: null });
      notes.push({ code: 'DEPTH_LIMIT', detail: limits.maxDepth });
    } else if (scan.stopped === 'nodes') {
      truncations.push({ what: 'nodes', max: limits.maxNodes, dropped: null });
      notes.push({ code: 'NODE_LIMIT', detail: limits.maxNodes });
    }
    const shown = scan.stopped === 'view' ? scan.pretty : source;
    const fitted = fitUtf8(shown, limits.maxViewBytes);
    const dropped =
      scan.stopped === 'view' ? scan.unread + fitted.cutChars : fitted.cutChars;
    if (scan.stopped === 'view' || dropped > 0) {
      truncations.push({ what: 'view', max: limits.maxViewBytes, dropped });
    }
    return {
      view: { kind: 'text', text: fitted.text, charset: 'utf-8' },
      type: 'json',
      mime: 'application/json',
      truncations,
      notes,
    };
  },
  encode(value) {
    const text = JSON.stringify(value) as string | undefined;
    return new TextEncoder().encode(text ?? 'null');
  },
};
