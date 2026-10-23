// Shared by the binary document codecs (msgpack, cbor): a budget for depth, values and string
// bytes, a safe way to set a key, and the view of a decoded value. Everything a decoder reads
// from the wire is checked against the bytes that are really left before anything is allocated.
import { fail } from './errors.ts';
import type { CodecLimits } from './limits.ts';
import type { FormatOutput, JsonValue, Truncation } from './types.ts';
import { fitUtf8 } from './views.ts';

export class TreeBudget {
  private nodes = 0;
  private text = 0;
  private readonly maxNodes: number;
  private readonly maxText: number;
  readonly maxDepth: number;

  constructor(limits: CodecLimits) {
    this.maxNodes = limits.maxNodes;
    this.maxDepth = limits.maxDepth;
    this.maxText = limits.maxViewBytes;
  }

  /** One value; fails above the node limit. */
  node(offset: number): void {
    this.nodes++;
    if (this.nodes > this.maxNodes) fail('NODE_LIMIT', offset);
  }

  /** Bytes of string or binary content that will show in the view. */
  content(bytes: number, offset: number): void {
    this.text += bytes;
    if (this.text > this.maxText) fail('OUTPUT_LIMIT', offset);
  }

  enter(depth: number, offset: number): void {
    if (depth > this.maxDepth) fail('DEPTH_LIMIT', offset);
  }
}

/** Sets an own enumerable property, including a key named `__proto__`. */
export function setOwn(
  target: Record<string, JsonValue>,
  key: string,
  value: JsonValue,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/** A map key as an object key: strings stay, everything else is written as JSON. */
export function keyText(key: JsonValue): string {
  return typeof key === 'string' ? key : JSON.stringify(key);
}

export function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString(
    'base64',
  );
}

/** A number that JSON can carry exactly, or its decimal text. */
export function wide(value: bigint): number | string {
  return value >= -9007199254740991n && value <= 9007199254740991n
    ? Number(value)
    : value.toString();
}

export function float(value: number): number | string {
  return Number.isFinite(value) ? value : String(value);
}

/** The view of a decoded document: a tree and its pretty text, or text when it is too long. */
export function documentOutput(
  value: JsonValue,
  type: string,
  mime: string,
  limits: CodecLimits,
): FormatOutput {
  const pretty = JSON.stringify(value, null, 2);
  const fitted = fitUtf8(pretty, limits.maxViewBytes);
  if (fitted.cutChars === 0) {
    return {
      view: { kind: 'tree', value, text: pretty },
      type,
      mime,
      truncations: [],
      notes: [],
    };
  }
  const truncations: Truncation[] = [
    { what: 'view', max: limits.maxViewBytes, dropped: fitted.cutChars },
  ];
  return {
    view: { kind: 'text', text: fitted.text, charset: 'utf-8' },
    type,
    mime,
    truncations,
    notes: [],
  };
}
