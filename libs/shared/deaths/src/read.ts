// Tolerant, bounded readers over untrusted values. A value is plain JavaScript, the engine's typed
// form (`{ t, v }`, the shape of `Delivery.headers`), amqplib's notation (`{ '!': 'timestamp',
// value }`) or a `Map`; every reader peels the wrappers and answers null (or undefined) for what it
// cannot use, so the caller never guesses. A getter or a Proxy that throws is counted in
// `ReadContext.errors` and read as absent: nothing in this file throws.
import { LIMITS } from './limits.ts';

/** The counters of one normalisation; the readers add to them, the caller reports them. */
export interface ReadContext {
  /** Reads that threw (hostile getters, revoked proxies). */
  errors: number;
  textsTruncated: number;
  routingKeysDropped: number;
  entriesDropped: number;
  /** What is left of the history's text budget (`LIMITS.maxTotalChars`). */
  charsLeft: number;
}

export function newContext(): ReadContext {
  return {
    errors: 0,
    textsTruncated: 0,
    routingKeysDropped: 0,
    entriesDropped: 0,
    charsLeft: LIMITS.maxTotalChars,
  };
}

const TYPED_TAGS: ReadonlySet<string> = new Set([
  'string',
  'long',
  'int',
  'short',
  'byte',
  'double',
  'float',
  'bool',
  'timestamp',
  'decimal',
  'bytes',
  'void',
  'array',
  'table',
]);

/** At most this many wrappers are peeled from one value, so a self-wrapping object ends. */
const MAX_PEEL = 4;

const isObject = (value: unknown): value is object =>
  typeof value === 'object' && value !== null;

/** Whether a (peeled) value can hold named fields: an object or a Map, not an array or bytes. */
export function isTable(value: unknown): value is object {
  return (
    isObject(value) &&
    !Array.isArray(value) &&
    !ArrayBuffer.isView(value) &&
    !(value instanceof Date)
  );
}

/** Removes the typed and the amqplib wrappers; a value that throws on inspection reads as absent. */
export function peel(ctx: ReadContext, value: unknown): unknown {
  try {
    let current = value;
    for (let step = 0; step < MAX_PEEL; step++) {
      if (!isTable(current) || current instanceof Map) return current;
      const table = current as Record<string, unknown>;
      if (
        Object.hasOwn(table, 't') &&
        Object.hasOwn(table, 'v') &&
        typeof table.t === 'string' &&
        TYPED_TAGS.has(table.t)
      ) {
        current = table.v;
      } else if (
        Object.hasOwn(table, '!') &&
        Object.hasOwn(table, 'value') &&
        typeof table['!'] === 'string'
      ) {
        current = table.value;
      } else {
        return current;
      }
    }
    return current;
  } catch {
    ctx.errors++;
    return undefined;
  }
}

/** The field `key` of a table (an own property, or a Map entry), peeled; undefined when absent. */
export function field(
  ctx: ReadContext,
  container: unknown,
  key: string,
): unknown {
  const table = peel(ctx, container);
  if (!isTable(table)) return undefined;
  try {
    if (table instanceof Map) return peel(ctx, table.get(key));
    if (!Object.hasOwn(table, key)) return undefined;
    return peel(ctx, (table as Record<string, unknown>)[key]);
  } catch {
    ctx.errors++;
    return undefined;
  }
}

export interface ArrayRead {
  /** At most `max` items, peeled; an item that could not be read is undefined. */
  readonly items: readonly unknown[];
  /** The length the array claims (0 when it cannot be read). */
  readonly total: number;
}

/**
 * The first `max` items of an array. Only indexes below `max` are touched, so a sparse array that
 * claims a length of 2^32 costs `max` reads. Null when the value is not an array.
 */
export function readArray(
  ctx: ReadContext,
  value: unknown,
  max: number,
): ArrayRead | null {
  const array = peel(ctx, value);
  if (!Array.isArray(array)) return null;
  try {
    const list: readonly unknown[] = array;
    const claimed: unknown = list.length;
    const total =
      typeof claimed === 'number' &&
      Number.isSafeInteger(claimed) &&
      claimed > 0
        ? claimed
        : 0;
    const items: unknown[] = [];
    for (let index = 0; index < Math.min(total, max); index++) {
      try {
        items.push(peel(ctx, list[index]));
      } catch {
        ctx.errors++;
        items.push(undefined);
      }
    }
    return { items, total };
  } catch {
    ctx.errors++;
    return null;
  }
}

export interface TextRead {
  readonly text: string;
  readonly truncated: boolean;
}

const DECODER = new TextDecoder('utf-8', { fatal: false });

/**
 * A string, or the UTF-8 of a byte string (a 0-9-1 `longstr` need not be text), cut to `max`
 * characters and to what is left of the history's budget. Null for any other value.
 */
export function readText(
  ctx: ReadContext,
  value: unknown,
  max: number = LIMITS.maxTextChars,
): TextRead | null {
  const peeled = peel(ctx, value);
  let text: string;
  let truncated = false;
  try {
    if (typeof peeled === 'string') {
      text = peeled;
    } else if (peeled instanceof Uint8Array) {
      truncated = peeled.byteLength > max;
      text = DECODER.decode(peeled.subarray(0, max));
    } else {
      return null;
    }
  } catch {
    ctx.errors++;
    return null;
  }
  if (text.length > max) {
    text = text.slice(0, max);
    truncated = true;
  }
  if (text.length > ctx.charsLeft) {
    text = text.slice(0, ctx.charsLeft);
    truncated = true;
  }
  // Never end on half of a surrogate pair.
  const last = text.charCodeAt(text.length - 1);
  if (truncated && last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
  ctx.charsLeft -= text.length;
  if (truncated) ctx.textsTruncated++;
  return { text, truncated };
}

/** A safe integer from a number or a bigint; null for anything else (no coercion of strings). */
export function readInteger(ctx: ReadContext, value: unknown): number | null {
  const peeled = peel(ctx, value);
  if (typeof peeled === 'number') {
    return Number.isSafeInteger(peeled) ? peeled : null;
  }
  if (typeof peeled === 'bigint') {
    return peeled >= BigInt(Number.MIN_SAFE_INTEGER) &&
      peeled <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(peeled)
      : null;
  }
  return null;
}

/**
 * An instant as epoch milliseconds. A `Date` is exact; a number or bigint is read in `unit`
 * (0-9-1 timestamps are seconds, 1.0 timestamps are milliseconds). A value outside
 * 1970..9999 is null: it is most likely in the other unit, and the unit is not guessed.
 */
export function readTimeMs(
  ctx: ReadContext,
  value: unknown,
  unit: 'seconds' | 'ms',
): number | null {
  const peeled = peel(ctx, value);
  let ms: number | null;
  if (peeled instanceof Date) {
    try {
      ms = peeled.getTime();
    } catch {
      ctx.errors++;
      return null;
    }
  } else {
    const whole = readInteger(ctx, peeled);
    ms = whole === null ? null : unit === 'seconds' ? whole * 1000 : whole;
  }
  return ms !== null &&
    Number.isSafeInteger(ms) &&
    ms >= 0 &&
    ms <= LIMITS.maxTimeMs
    ? ms
    : null;
}
