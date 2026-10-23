// XML as a checked, indented text view; there is no DOM and no entity table, so no expansion
// attack can exist (OQ-961). A document type declaration is refused outright, only the five
// predefined entities and numeric references are accepted, and nesting depth, value count and the
// size of the view are limited. Elements, attributes (quoted, unique), comments, CDATA and
// processing instructions are checked for well-formedness; one root element is required.
import { decodeText, canonicalCharset } from './charset.ts';
import { fail } from './errors.ts';
import type {
  CodecNote,
  FormatCodec,
  FormatOutput,
  Truncation,
} from './types.ts';
import { fitUtf8 } from './views.ts';

const LT = 0x3c;
const NAME = /[A-Za-z_:À-￿][-A-Za-z0-9_:.·À-￿]*/y;
const MAX_ATTRIBUTES = 256;
const PREDEFINED = new Set(['lt', 'gt', 'amp', 'quot', 'apos']);
const INDENTS: string[] = [];
for (let depth = 0; depth <= 65; depth++) {
  INDENTS.push(`\n${'  '.repeat(depth)}`);
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function skipSpace(text: string, from: number): number {
  let at = from;
  while (isSpace(text.charCodeAt(at))) at++;
  return at;
}

function nameAt(text: string, from: number): string {
  NAME.lastIndex = from;
  const match = NAME.exec(text);
  return match === null ? fail('MALFORMED_XML', from) : match[0];
}

/** Checks the references and the characters of a run of text or an attribute value. */
function checkText(text: string, from: number, to: number): void {
  for (let at = from; at < to; at++) {
    const code = text.charCodeAt(at);
    if (code < 0x20 && !isSpace(code)) fail('MALFORMED_XML', at);
    if (code === 0x26) {
      const end = text.indexOf(';', at);
      if (end === -1 || end > to || end - at > 12) fail('MALFORMED_XML', at);
      const body = text.slice(at + 1, end);
      if (body.startsWith('#')) {
        const hex = body.startsWith('#x');
        const digits = body.slice(hex ? 2 : 1);
        const valid = hex
          ? /^[0-9a-fA-F]{1,6}$/.test(digits)
          : /^[0-9]{1,7}$/.test(digits);
        const value = valid ? Number.parseInt(digits, hex ? 16 : 10) : -1;
        if (
          value < 1 ||
          value > 0x10ffff ||
          (value >= 0xd800 && value <= 0xdfff)
        ) {
          fail('MALFORMED_XML', at);
        }
      } else if (!PREDEFINED.has(body)) {
        fail('XML_ENTITY', at);
      }
      at = end;
    }
  }
}

interface Scan {
  readonly pretty: string;
  readonly stopped: 'depth' | 'nodes' | 'view' | null;
  readonly unread: number;
}

function scanXml(
  text: string,
  maxDepth: number,
  maxNodes: number,
  maxChars: number,
): Scan {
  const n = text.length;
  const parts: string[] = [];
  const open: { name: string; child: boolean; inline: boolean }[] = [];
  let length = 0;
  let nodes = 0;
  let at = 0;
  let root = false;
  const emit = (piece: string): void => {
    parts.push(piece);
    length += piece.length;
  };
  const line = (piece: string): void => {
    const top = open[open.length - 1];
    if (top !== undefined) top.child = true;
    emit(`${parts.length === 0 ? '' : (INDENTS[open.length] ?? '\n')}${piece}`);
  };
  const stop = (stopped: 'depth' | 'nodes' | 'view'): Scan => ({
    pretty: parts.join(''),
    stopped,
    unread: n - at,
  });

  while (at < n) {
    if (length > maxChars) return stop('view');
    if (text.charCodeAt(at) !== LT) {
      // Character data up to the next tag.
      let end = text.indexOf('<', at);
      if (end === -1) end = n;
      checkText(text, at, end);
      const run = text.slice(at, end);
      const cdataEnd = run.indexOf(']]>');
      if (cdataEnd !== -1) fail('MALFORMED_XML', at + cdataEnd);
      const blank = run.trim() === '';
      if (open.length === 0) {
        if (!blank) fail('MALFORMED_XML', at);
      } else if (!blank) {
        if (++nodes > maxNodes) return stop('nodes');
        const top = open[open.length - 1];
        if (top !== undefined && !top.child) {
          top.inline = true;
          emit(run);
        } else {
          line(run.trim());
        }
      }
      at = end;
      continue;
    }
    if (text.startsWith('<!--', at)) {
      const end = text.indexOf('-->', at + 4);
      if (end === -1) return fail('MALFORMED_XML', n);
      const body = text.slice(at + 4, end);
      if (body.includes('--') || body.endsWith('-')) fail('MALFORMED_XML', at);
      if (++nodes > maxNodes) return stop('nodes');
      line(text.slice(at, end + 3));
      at = end + 3;
    } else if (text.startsWith('<![CDATA[', at)) {
      const end = text.indexOf(']]>', at + 9);
      if (end === -1 || open.length === 0) return fail('MALFORMED_XML', at);
      if (++nodes > maxNodes) return stop('nodes');
      const top = open[open.length - 1];
      if (top !== undefined && !top.child) {
        top.inline = true;
        emit(text.slice(at, end + 3));
      } else {
        line(text.slice(at, end + 3));
      }
      at = end + 3;
    } else if (text.startsWith('<!', at)) {
      // <!DOCTYPE and <!ENTITY are where entity expansion attacks live; neither is read.
      return fail(
        /^<!(?:DOCTYPE|ENTITY|ELEMENT|ATTLIST|NOTATION)/i.test(
          text.slice(at, at + 12),
        )
          ? 'XML_DOCTYPE'
          : 'MALFORMED_XML',
        at,
      );
    } else if (text.startsWith('<?', at)) {
      const end = text.indexOf('?>', at + 2);
      if (end === -1) return fail('MALFORMED_XML', n);
      nameAt(text, at + 2);
      if (++nodes > maxNodes) return stop('nodes');
      line(text.slice(at, end + 2));
      at = end + 2;
    } else if (text.startsWith('</', at)) {
      const name = nameAt(text, at + 2);
      const close = skipSpace(text, at + 2 + name.length);
      if (text.charCodeAt(close) !== 0x3e) return fail('MALFORMED_XML', close);
      const top = open.pop();
      if (top?.name !== name) return fail('MALFORMED_XML', at);
      if (top.inline || !top.child) {
        emit(`</${name}>`);
      } else {
        emit(`${INDENTS[open.length] ?? '\n'}</${name}>`);
      }
      at = close + 1;
    } else {
      // A start tag.
      if (open.length === 0 && root) return fail('MALFORMED_XML', at);
      const name = nameAt(text, at + 1);
      let cursor = at + 1 + name.length;
      const seen = new Set<string>();
      const attributes: string[] = [];
      for (;;) {
        const before = cursor;
        cursor = skipSpace(text, cursor);
        const code = text.charCodeAt(cursor);
        if (code === 0x3e || code === 0x2f) break;
        if (cursor === before || seen.size >= MAX_ATTRIBUTES) {
          return fail('MALFORMED_XML', cursor);
        }
        const attribute = nameAt(text, cursor);
        if (seen.has(attribute)) return fail('MALFORMED_XML', cursor);
        seen.add(attribute);
        cursor = skipSpace(text, cursor + attribute.length);
        if (text.charCodeAt(cursor) !== 0x3d)
          return fail('MALFORMED_XML', cursor);
        cursor = skipSpace(text, cursor + 1);
        const quote = text.charCodeAt(cursor);
        if (quote !== 0x22 && quote !== 0x27)
          return fail('MALFORMED_XML', cursor);
        const end = text.indexOf(String.fromCharCode(quote), cursor + 1);
        if (end === -1) return fail('MALFORMED_XML', n);
        const value = text.slice(cursor + 1, end);
        if (value.includes('<')) return fail('MALFORMED_XML', cursor);
        checkText(text, cursor + 1, end);
        attributes.push(`${attribute}=${text.slice(cursor, end + 1)}`);
        cursor = end + 1;
      }
      const selfClosing = text.charCodeAt(cursor) === 0x2f;
      if (selfClosing) {
        if (text.charCodeAt(cursor + 1) !== 0x3e)
          return fail('MALFORMED_XML', cursor);
        cursor++;
      }
      if (++nodes > maxNodes) return stop('nodes');
      if (!selfClosing && open.length >= maxDepth) return stop('depth');
      const head = `<${[name, ...attributes].join(' ')}${selfClosing ? '/' : ''}>`;
      line(head);
      if (open.length === 0) root = true;
      if (!selfClosing) open.push({ name, child: false, inline: false });
      at = cursor + 1;
    }
  }
  if (open.length > 0 || !root) return fail('MALFORMED_XML', n);
  return { pretty: parts.join(''), stopped: null, unread: 0 };
}

/** The encoding named by the XML declaration, read from the first bytes. */
function declaredEncoding(bytes: Uint8Array): string | undefined {
  const head = Buffer.from(bytes.subarray(0, 200)).toString('latin1');
  const match =
    /^\s*<\?xml[^>]*?encoding\s*=\s*["']([A-Za-z0-9._-]{1,40})["']/.exec(head);
  const label = match?.[1];
  return label !== undefined && canonicalCharset(label) !== undefined
    ? label
    : undefined;
}

export const xmlCodec: FormatCodec = {
  kind: 'format',
  id: 'xml',
  mimes: ['application/xml', 'text/xml', '+xml'],
  detect(sample) {
    let at =
      sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf ? 3 : 0;
    while (isSpace(sample[at] ?? 0)) at++;
    if (sample[at] !== LT) return 0;
    const head = Buffer.from(sample.subarray(at, at + 8)).toString('latin1');
    if (head.startsWith('<?xml')) return 0.9;
    return /^<[A-Za-z_]/.test(head) ? 0.55 : 0;
  },
  decode(bytes, context): FormatOutput {
    const { limits } = context;
    const decoded = decodeText(bytes, {
      declared: context.charset ?? declaredEncoding(bytes),
      maxBytes: limits.maxInputBytes,
      lossy: false,
    });
    const scan = scanXml(
      decoded.text,
      limits.maxDepth,
      limits.maxNodes,
      limits.maxViewBytes,
    );
    const truncations: Truncation[] = [];
    const notes: CodecNote[] = [];
    let shown = scan.pretty;
    let dropped = 0;
    if (scan.stopped === 'depth') {
      truncations.push({ what: 'depth', max: limits.maxDepth, dropped: null });
      notes.push({ code: 'DEPTH_LIMIT', detail: limits.maxDepth });
      shown = decoded.text;
    } else if (scan.stopped === 'nodes') {
      truncations.push({ what: 'nodes', max: limits.maxNodes, dropped: null });
      notes.push({ code: 'NODE_LIMIT', detail: limits.maxNodes });
      shown = decoded.text;
    } else if (scan.stopped === 'view') {
      dropped = scan.unread;
    }
    const fitted = fitUtf8(shown, limits.maxViewBytes);
    dropped += fitted.cutChars;
    if (dropped > 0) {
      truncations.push({ what: 'view', max: limits.maxViewBytes, dropped });
    }
    return {
      view: { kind: 'text', text: fitted.text, charset: 'utf-8' },
      type: 'xml',
      mime: 'application/xml',
      truncations,
      notes,
    };
  },
};
