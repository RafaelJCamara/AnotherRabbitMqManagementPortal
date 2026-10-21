import type { JsonStreamReason } from './errors';

/** Thrown by the scanner; the reader turns it into a `JsonStreamError` with the position. */
export class ScanFault extends Error {
  readonly reason: JsonStreamReason;
  constructor(reason: JsonStreamReason) {
    super(reason);
    this.name = 'ScanFault';
    this.reason = reason;
  }
}

export type ScanStep =
  /** One item, cut out of the input (not yet decoded or parsed). Never empty. */
  | { readonly kind: 'item'; readonly bytes: Uint8Array }
  /** The pushed chunk is used up: push the next one. */
  | { readonly kind: 'more' };

type Phase =
  | 'head' // before the opening bracket
  | 'first' // after `[`, before the first item or `]`
  | 'next' // after a `,`, before the next item
  | 'item' // inside an item
  | 'done'; // after the closing bracket

const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const SPACE = 0x20;
const QUOTE = 0x22;
const COMMA = 0x2c;
const BACKSLASH = 0x5c;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;

const EMPTY = new Uint8Array(0);

function fail(reason: JsonStreamReason): never {
  throw new ScanFault(reason);
}

/**
 * Walks the bytes of ONE top-level JSON array and finds where each item starts and ends. It is a
 * plain synchronous state machine: push a chunk, call `next()` until it says `more`.
 *
 * The structural bytes (`"` `\` `[` `]` `{` `}` `,`) are ASCII and never occur inside a multi-byte
 * UTF-8 sequence, so scanning bytes is exact. Brackets are counted, not paired by kind: a mismatch
 * such as `{"a":[1}` shows later as an item that does not parse, a body that ends, or an item over
 * the byte limit, and the read fails closed at whichever comes first.
 *
 * Memory: the current chunk (owned by the caller) plus the part of the current item that lay in
 * earlier chunks, at most `maxItemBytes`. A part is copied out of its chunk so the chunk can go.
 */
export class ArrayScanner {
  readonly #maxItemBytes: number;
  readonly #maxDepth: number;
  #phase: Phase = 'head';
  #chunk: Uint8Array = EMPTY;
  #pos = 0;
  // State of the item being scanned.
  #parts: Uint8Array[] = [];
  #held = 0;
  #segStart = 0;
  #depth = 0;
  #inString = false;
  #escaped = false;

  constructor(maxItemBytes: number, maxDepth: number) {
    this.#maxItemBytes = maxItemBytes;
    this.#maxDepth = maxDepth;
  }

  /** The closing bracket has been seen. */
  get closed(): boolean {
    return this.#phase === 'done';
  }

  push(chunk: Uint8Array): void {
    this.#chunk = chunk;
    this.#pos = 0;
  }

  /**
   * Only after an item that ended with `,`: is an item start in view? `more` when the chunk ends
   * first. `]` (a trailing comma) and `,` (an empty item) are malformed. Consumes blanks only.
   */
  peekItem(): 'item' | 'more' {
    if (this.#phase !== 'next')
      throw new Error('peekItem needs a separator before it.');
    if (this.#skipBlanks()) return 'more';
    const c = this.#chunk[this.#pos];
    if (c === CLOSE_BRACKET || c === COMMA) fail('malformed');
    return 'item';
  }

  next(): ScanStep {
    for (;;) {
      switch (this.#phase) {
        case 'head': {
          if (this.#skipBlanks()) return { kind: 'more' };
          if (this.#chunk[this.#pos] !== OPEN_BRACKET) fail('not-an-array');
          this.#pos += 1;
          this.#phase = 'first';
          break;
        }
        case 'first':
        case 'next': {
          if (this.#skipBlanks()) return { kind: 'more' };
          const c = this.#chunk[this.#pos];
          if (c === CLOSE_BRACKET) {
            // `[]` is an empty array; `[1,]` is a trailing comma.
            if (this.#phase === 'next') fail('malformed');
            this.#pos += 1;
            this.#phase = 'done';
          } else if (c === COMMA) {
            fail('malformed'); // an empty item: `[,1]` or `[1,,2]`
          } else {
            this.#phase = 'item';
            this.#segStart = this.#pos;
            this.#parts = [];
            this.#held = 0;
            this.#depth = 0;
            this.#inString = false;
            this.#escaped = false;
          }
          break;
        }
        case 'item': {
          return this.#scanItem();
        }
        case 'done': {
          if (!this.#skipBlanks()) fail('trailing-data');
          return { kind: 'more' };
        }
      }
    }
  }

  /** Moves past blanks. True when the chunk ended first. */
  #skipBlanks(): boolean {
    const chunk = this.#chunk;
    let i = this.#pos;
    while (i < chunk.length) {
      const c = chunk[i];
      if (c !== SPACE && c !== LINE_FEED && c !== CARRIAGE_RETURN && c !== TAB)
        break;
      i += 1;
    }
    this.#pos = i;
    return i >= chunk.length;
  }

  #scanItem(): ScanStep {
    const chunk = this.#chunk;
    const end = chunk.length;
    const maxDepth = this.#maxDepth;
    let depth = this.#depth;
    let inString = this.#inString;
    let escaped = this.#escaped;
    let terminator = 0; // COMMA or CLOSE_BRACKET once the item ends
    let i = this.#pos;
    for (; i < end; i += 1) {
      const c = chunk[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === BACKSLASH) escaped = true;
        else if (c === QUOTE) inString = false;
        continue;
      }
      if (c === QUOTE) {
        inString = true;
      } else if (c === OPEN_BRACKET || c === OPEN_BRACE) {
        depth += 1;
        if (depth > maxDepth) fail('too-deep');
      } else if (c === CLOSE_BRACKET || c === CLOSE_BRACE) {
        if (depth > 0) depth -= 1;
        else if (c === CLOSE_BRACE) fail('malformed');
        else {
          terminator = CLOSE_BRACKET;
          break;
        }
      } else if (c === COMMA && depth === 0) {
        terminator = COMMA;
        break;
      }
    }

    if (terminator === 0) {
      // The chunk ended inside the item: keep a copy of this part, check the size, ask for more.
      const part = chunk.slice(this.#segStart, end);
      this.#held += part.length;
      if (this.#held > this.#maxItemBytes) fail('too-large');
      this.#parts.push(part);
      this.#segStart = 0;
      this.#depth = depth;
      this.#inString = inString;
      this.#escaped = escaped;
      this.#pos = end;
      return { kind: 'more' };
    }

    const last = chunk.subarray(this.#segStart, i);
    if (this.#held + last.length > this.#maxItemBytes) fail('too-large');
    const bytes =
      this.#parts.length === 0 ? last : concat(this.#parts, last, this.#held);
    this.#parts = [];
    this.#held = 0;
    this.#pos = i + 1;
    this.#phase = terminator === COMMA ? 'next' : 'done';
    return { kind: 'item', bytes };
  }
}

function concat(
  parts: readonly Uint8Array[],
  last: Uint8Array,
  held: number,
): Uint8Array {
  const out = new Uint8Array(held + last.length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  out.set(last, at);
  return out;
}
