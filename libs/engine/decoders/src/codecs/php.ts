// PHP `serialize()` text as a token listing (blueprint 11, OQ-966). `unserialize` can instantiate
// any class and run its magic methods, so this codec NEVER unserializes: it reads the length-
// prefixed grammar and prints each value with its type tag, in the style of `var_dump`. Class
// names are printed, never looked up. There is no object creation, no `eval`, no `Function`.
import { fail } from './errors.ts';
import { TreeBudget } from './tree.ts';
import type { FormatCodec, Truncation } from './types.ts';
import { fitUtf8 } from './views.ts';

const SHOWN = 120;

class Cursor {
  at = 0;
  readonly bytes: Uint8Array;
  readonly lines: string[] = [];
  used = 0;
  readonly budget: TreeBudget;
  readonly maxChars: number;

  constructor(bytes: Uint8Array, budget: TreeBudget, maxChars: number) {
    this.bytes = bytes;
    this.budget = budget;
    this.maxChars = maxChars;
  }

  byte(): number {
    const value = this.bytes[this.at];
    if (value === undefined) return fail('MALFORMED_PHP', this.bytes.length);
    return value;
  }

  expect(char: string): void {
    if (this.byte() !== char.charCodeAt(0)) fail('MALFORMED_PHP', this.at);
    this.at++;
  }

  /** An unsigned or signed decimal up to (not including) `stop`. */
  integer(stop: string, signed: boolean): number {
    const start = this.at;
    if (signed && this.byte() === 0x2d) this.at++;
    const first = this.at;
    while (
      this.at < this.bytes.length &&
      this.byte() >= 0x30 &&
      this.byte() <= 0x39
    ) {
      this.at++;
    }
    if (this.at === first || this.at - first > 15) fail('MALFORMED_PHP', start);
    const value = Number(
      Buffer.from(this.bytes.subarray(start, this.at)).toString('latin1'),
    );
    this.expect(stop);
    return value;
  }

  take(size: number): Uint8Array {
    if (size > this.bytes.length - this.at)
      fail('MALFORMED_PHP', this.bytes.length);
    const out = this.bytes.subarray(this.at, this.at + size);
    this.at += size;
    return out;
  }

  emit(depth: number, text: string): void {
    this.lines.push(`${'  '.repeat(depth - 1)}${text}`);
    this.used += text.length + depth * 2 + 1;
    if (this.used > this.maxChars * 2) fail('OUTPUT_LIMIT', this.at);
  }
}

function shownText(bytes: Uint8Array): string {
  const text = Buffer.from(bytes.subarray(0, SHOWN)).toString('utf8');
  const escaped = JSON.stringify(text);
  return bytes.length > SHOWN ? `${escaped}...` : escaped;
}

/** `s:LEN:"..." ` after the `s:` has been read. */
function stringBody(cursor: Cursor): Uint8Array {
  const size = cursor.integer(':', false);
  cursor.expect('"');
  const raw = cursor.take(size);
  cursor.expect('"');
  return raw;
}

function value(cursor: Cursor, depth: number, label: string): void {
  cursor.budget.enter(depth, cursor.at);
  cursor.budget.node(cursor.at);
  const tag = cursor.byte();
  cursor.at++;
  const prefix = label === '' ? '' : `${label} => `;
  switch (String.fromCharCode(tag)) {
    case 'N':
      cursor.expect(';');
      cursor.emit(depth, `${prefix}NULL`);
      return;
    case 'b': {
      cursor.expect(':');
      const flag = cursor.byte();
      if (flag !== 0x30 && flag !== 0x31) fail('MALFORMED_PHP', cursor.at);
      cursor.at++;
      cursor.expect(';');
      cursor.emit(depth, `${prefix}bool(${flag === 0x31 ? 'true' : 'false'})`);
      return;
    }
    case 'i': {
      cursor.expect(':');
      const n = cursor.integer(';', true);
      cursor.emit(depth, `${prefix}int(${String(n)})`);
      return;
    }
    case 'd': {
      cursor.expect(':');
      const end = cursor.bytes.indexOf(0x3b, cursor.at);
      if (end === -1 || end - cursor.at > 40) fail('MALFORMED_PHP', cursor.at);
      const text = Buffer.from(cursor.take(end - cursor.at)).toString('latin1');
      if (
        !/^-?(?:[0-9]+(?:\.[0-9]*)?(?:[eE][+-]?[0-9]+)?|INF|NAN)$/.test(text)
      ) {
        fail('MALFORMED_PHP', cursor.at);
      }
      cursor.expect(';');
      cursor.emit(depth, `${prefix}float(${text})`);
      return;
    }
    case 's': {
      cursor.expect(':');
      const raw = stringBody(cursor);
      cursor.expect(';');
      cursor.budget.content(raw.length, cursor.at);
      cursor.emit(
        depth,
        `${prefix}string(${String(raw.length)}) ${shownText(raw)}`,
      );
      return;
    }
    case 'a': {
      cursor.expect(':');
      const count = cursor.integer(':', false);
      cursor.expect('{');
      cursor.emit(depth, `${prefix}array(${String(count)}) {`);
      members(cursor, depth, count);
      return;
    }
    case 'O': {
      cursor.expect(':');
      const name = stringBody(cursor);
      cursor.expect(':');
      const count = cursor.integer(':', false);
      cursor.expect('{');
      cursor.emit(
        depth,
        `${prefix}object(${shownText(name)}) (${String(count)}) {`,
      );
      members(cursor, depth, count);
      return;
    }
    case 'E': {
      cursor.expect(':');
      const raw = stringBody(cursor);
      cursor.expect(';');
      cursor.emit(depth, `${prefix}enum(${shownText(raw)})`);
      return;
    }
    case 'C': {
      cursor.expect(':');
      const name = stringBody(cursor);
      cursor.expect(':');
      const size = cursor.integer(':', false);
      cursor.expect('{');
      const data = cursor.take(size);
      cursor.expect('}');
      cursor.emit(
        depth,
        `${prefix}custom-serialized object(${shownText(name)}) ${shownText(data)}`,
      );
      return;
    }
    case 'r':
    case 'R': {
      cursor.expect(':');
      const n = cursor.integer(';', false);
      cursor.emit(
        depth,
        `${prefix}${tag === 0x72 ? 'object reference' : 'reference'} to #${String(n)}`,
      );
      return;
    }
    default:
      fail('MALFORMED_PHP', cursor.at - 1);
  }
}

function members(cursor: Cursor, depth: number, count: number): void {
  // Every member takes at least six bytes (`i:0;N;`).
  if (count * 6 > cursor.bytes.length - cursor.at)
    fail('MALFORMED_PHP', cursor.bytes.length);
  for (let i = 0; i < count; i++) {
    const tag = cursor.byte();
    let key: string;
    if (tag === 0x69) {
      cursor.at++;
      cursor.expect(':');
      key = `[${String(cursor.integer(';', true))}]`;
    } else if (tag === 0x73) {
      cursor.at++;
      cursor.expect(':');
      const raw = stringBody(cursor);
      cursor.expect(';');
      // Property names of private and protected members hold NUL bytes.
      key = `[${shownText(raw).replaceAll('\\u0000', '\\0')}]`;
    } else {
      return fail('MALFORMED_PHP', cursor.at);
    }
    value(cursor, depth + 1, key);
  }
  cursor.expect('}');
  cursor.emit(depth, '}');
}

export const phpCodec: FormatCodec = {
  kind: 'format',
  id: 'php',
  mimes: ['application/vnd.php.serialized', 'application/x-php-serialized'],
  detect(sample) {
    const head = Buffer.from(sample.subarray(0, 24)).toString('latin1');
    return /^(?:a:[0-9]+:\{|O:[0-9]+:"|s:[0-9]+:")/.test(head) ? 0.8 : 0;
  },
  decode(bytes, context) {
    const { limits } = context;
    const cursor = new Cursor(
      bytes,
      new TreeBudget(limits),
      limits.maxViewBytes,
    );
    value(cursor, 1, '');
    if (cursor.at !== bytes.length) fail('MALFORMED_PHP', cursor.at);
    const header = [
      'PHP serialize() token listing. Not unserialized: no class was loaded and nothing was run.',
      'Class names are shown as written.',
      '',
    ];
    const fitted = fitUtf8(
      [...header, ...cursor.lines].join('\n'),
      limits.maxViewBytes,
    );
    const truncations: Truncation[] =
      fitted.cutChars > 0
        ? [{ what: 'view', max: limits.maxViewBytes, dropped: fitted.cutChars }]
        : [];
    return {
      view: { kind: 'disassembly', text: fitted.text, deserialised: false },
      type: 'php-serialized',
      mime: 'application/vnd.php.serialized',
      truncations,
      notes: [],
    };
  },
};
