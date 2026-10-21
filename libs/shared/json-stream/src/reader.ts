import { JsonStreamError } from './errors';
import { ArrayScanner, ScanFault } from './scanner';

export interface ArrayLimits {
  /** Items delivered. Must be at least 1. */
  readonly maxItems: number;
  /** Bytes taken from the source, whatever they are. */
  readonly maxBytes: number;
  /** Bytes of one item. */
  readonly maxItemBytes: number;
  /** Nesting inside one item. Default 64. */
  readonly maxDepth?: number;
}

export type ArrayEnd =
  /** The closing bracket was seen: `items` is the exact length of the array. */
  | {
      readonly kind: 'complete';
      readonly items: number;
      readonly bytes: number;
    }
  /** `maxItems` delivered and one more item follows: the length is not known and is at least `items + 1`. */
  | {
      readonly kind: 'item-limit';
      readonly items: number;
      readonly bytes: number;
    };

export interface JsonStream {
  /** From the first significant byte: `[` array, `{` object, anything else other, nothing but blanks empty. */
  readonly shape: 'array' | 'object' | 'other' | 'empty';
  /**
   * Delivers the items one by one. The source is always settled when the generator ends: read to
   * its end, or cancelled with `return()` (a `break` of the caller, an error, the item limit).
   * Needs shape 'array' (otherwise `not-an-array`). One call per stream.
   */
  array(limits: ArrayLimits): AsyncGenerator<unknown, ArrayEnd, undefined>;
}

const DEFAULT_MAX_DEPTH = 64;
const OPEN_BRACKET = 0x5b;
const OPEN_BRACE = 0x7b;

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function isBlank(c: number): boolean {
  return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
}

function positiveInteger(value: number | undefined, name: string): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
  return value;
}

/** Cuts, decodes and parses one item. Any fault is `malformed`; the platform's text is dropped (I-10). */
function parseItem(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    throw new ScanFault('malformed');
  }
}

/**
 * Reads up to the first significant byte (blanks may span chunks), then stops pulling. The body is
 * never held whole: `array()` holds one chunk plus one item.
 */
export async function openJson(
  source: AsyncIterable<Uint8Array>,
): Promise<JsonStream> {
  const iterator = source[Symbol.asyncIterator]();
  let finished = false; // the iterator is done, has thrown or has been returned
  let leading = 0; // blank bytes taken before the first significant one
  let head: Uint8Array | undefined; // the chunk that holds it, from that byte on
  let claimed = false;

  const pull = async (): Promise<Uint8Array | undefined> => {
    for (;;) {
      let result: IteratorResult<Uint8Array>;
      try {
        result = await iterator.next();
      } catch (error) {
        finished = true;
        throw error;
      }
      if (result.done) {
        finished = true;
        return undefined;
      }
      if (result.value.length > 0) return result.value;
    }
  };

  const cancel = async (): Promise<void> => {
    if (finished) return;
    finished = true;
    try {
      await iterator.return?.();
    } catch {
      // The fault being reported matters more than a failed cancel.
    }
  };

  for (;;) {
    const chunk = await pull();
    if (chunk === undefined) break;
    let at = 0;
    for (let c = chunk[at]; c !== undefined && isBlank(c); c = chunk[at])
      at += 1;
    leading += at;
    if (at < chunk.length) {
      head = chunk.subarray(at);
      break;
    }
  }

  const first = head?.[0];
  const shape: JsonStream['shape'] =
    first === undefined
      ? 'empty'
      : first === OPEN_BRACKET
        ? 'array'
        : first === OPEN_BRACE
          ? 'object'
          : 'other';

  async function* run(
    limits: ArrayLimits,
    maxDepth: number,
  ): AsyncGenerator<unknown, ArrayEnd, undefined> {
    const { maxItems, maxBytes, maxItemBytes } = limits;
    const scanner = new ArrayScanner(maxItemBytes, maxDepth);
    let taken = leading;
    let delivered = 0;
    let pending = head;
    head = undefined;
    const error = (reason: ScanFault['reason']): JsonStreamError =>
      new JsonStreamError(reason, taken, delivered);

    try {
      if (shape !== 'array') throw error('not-an-array');
      if (taken > maxBytes) throw error('too-large');

      /** The next chunk is scanned only if the total stays within maxBytes. */
      const feed = async (): Promise<boolean> => {
        const chunk = pending ?? (await pull());
        pending = undefined;
        if (chunk === undefined) return false;
        if (taken + chunk.length > maxBytes) throw error('too-large');
        taken += chunk.length;
        scanner.push(chunk);
        return true;
      };

      for (;;) {
        let step;
        try {
          step = scanner.next();
        } catch (fault) {
          throw fault instanceof ScanFault ? error(fault.reason) : fault;
        }
        if (step.kind === 'more') {
          if (await feed()) continue;
          if (scanner.closed)
            return { kind: 'complete', items: delivered, bytes: taken };
          throw error('truncated');
        }

        let value: unknown;
        try {
          value = parseItem(step.bytes);
        } catch (fault) {
          throw fault instanceof ScanFault ? error(fault.reason) : fault;
        }
        delivered += 1;
        yield value;

        if (delivered < maxItems || scanner.closed) continue;

        // The limit is reached and the array goes on after a comma: look one item start ahead.
        for (;;) {
          let look;
          try {
            look = scanner.peekItem();
          } catch (fault) {
            throw fault instanceof ScanFault ? error(fault.reason) : fault;
          }
          if (look === 'item')
            return { kind: 'item-limit', items: delivered, bytes: taken };
          if (!(await feed())) throw error('truncated');
        }
      }
    } finally {
      await cancel();
    }
  }

  return {
    shape,
    array(limits) {
      const maxItems = positiveInteger(limits.maxItems, 'maxItems');
      const maxBytes = positiveInteger(limits.maxBytes, 'maxBytes');
      const maxItemBytes = positiveInteger(limits.maxItemBytes, 'maxItemBytes');
      const maxDepth = positiveInteger(
        limits.maxDepth ?? DEFAULT_MAX_DEPTH,
        'maxDepth',
      );
      if (claimed) throw new Error('The stream was already read.');
      claimed = true;
      return run({ maxItems, maxBytes, maxItemBytes }, maxDepth);
    },
  };
}
