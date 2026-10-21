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

export interface OpenOptions {
  /** Ends the read with `aborted`, even when the source is silent. */
  readonly signal?: AbortSignal;
  /** Bytes scanned between two calls of `yieldNow`. Default 262_144. */
  readonly yieldEveryBytes?: number;
  /** Items delivered between two calls of `yieldNow`. Default 5_000. */
  readonly yieldEveryItems?: number;
  /** Lets the event loop run. Default `() => new Promise((r) => setTimeout(r, 0))`. */
  readonly yieldNow?: () => Promise<void>;
}

export interface JsonStream {
  /** From the first significant byte: `[` array, `{` object, anything else other, nothing but blanks empty. */
  readonly shape: 'array' | 'object' | 'other' | 'empty';
  /**
   * Delivers the items one by one. The source is always settled when the generator ends: read to
   * its end, or cancelled with `return()` (a `break` of the caller, an error, the item limit).
   * Needs shape 'array' (otherwise `not-an-array`). One call of `array()` or `value()` per stream.
   */
  array(limits: ArrayLimits): AsyncGenerator<unknown, ArrayEnd, undefined>;
  /**
   * Buffers the rest of the body, at most `maxBytes` taken from the source, and parses it (the paged
   * envelope). `too-large` past the limit, `truncated` when the source ends inside the value,
   * `malformed` otherwise. The source is settled on every ending.
   */
  value(maxBytes: number): Promise<unknown>;
  /** Cancels the source if nothing consumed it. Safe to call twice. */
  close(): Promise<void>;
}

const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_YIELD_BYTES = 262_144;
const DEFAULT_YIELD_ITEMS = 5_000;
const OPEN_BRACKET = 0x5b;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACKET = 0x5d;
const CLOSE_BRACE = 0x7d;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function isBlank(c: number): boolean {
  return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
}

const defaultYieldNow = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/** Settles with `promise`, or rejects at once when `signal` aborts (the promise is left to settle alone). */
function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new ScanFault('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        // An Error of the source passes on unchanged; anything else thrown becomes a plain Error.
        reject(error instanceof Error ? error : new Error('Source failed.'));
      },
    );
  });
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
  options: OpenOptions = {},
): Promise<JsonStream> {
  const { signal } = options;
  const yieldEveryBytes = positiveInteger(
    options.yieldEveryBytes ?? DEFAULT_YIELD_BYTES,
    'yieldEveryBytes',
  );
  const yieldEveryItems = positiveInteger(
    options.yieldEveryItems ?? DEFAULT_YIELD_ITEMS,
    'yieldEveryItems',
  );
  const yieldNow = options.yieldNow ?? defaultYieldNow;
  const iterator = source[Symbol.asyncIterator]();
  let finished = false; // the iterator is done, has thrown or has been returned
  let abandoned = false; // an abort won the race against a pending `next()`
  let leading = 0; // blank bytes taken before the first significant one
  let head: Uint8Array | undefined; // the chunk that holds it, from that byte on
  let claimed = false;
  let bytesSinceYield = 0;
  let itemsSinceYield = 0;

  const pull = async (): Promise<Uint8Array | undefined> => {
    for (;;) {
      if (signal?.aborted === true) throw new ScanFault('aborted');
      let result: IteratorResult<Uint8Array>;
      try {
        result = await raceAbort(iterator.next(), signal);
      } catch (error) {
        if (error instanceof ScanFault) abandoned = true;
        else finished = true;
        throw error;
      }
      if (result.done) {
        finished = true;
        return undefined;
      }
      if (result.value.length > 0) return result.value;
    }
  };

  /** Settles the source. After an abort a pending `next()` may never settle, so `return()` is not awaited then. */
  const cancel = async (): Promise<void> => {
    if (finished) return;
    finished = true;
    try {
      const done = iterator.return?.();
      if (abandoned || signal?.aborted === true)
        void done?.then(undefined, () => undefined);
      else await done;
    } catch {
      // The fault being reported matters more than a failed cancel.
    }
  };

  /** Lets the event loop run once `yieldEveryBytes` were scanned or `yieldEveryItems` delivered since the last time (I-5). */
  const maybeYield = async (): Promise<void> => {
    if (bytesSinceYield < yieldEveryBytes && itemsSinceYield < yieldEveryItems)
      return;
    bytesSinceYield = 0;
    itemsSinceYield = 0;
    await yieldNow();
  };

  /** A pull that reports a fault of the pull (an abort) with the position and the count. */
  const pullAs = async (
    error: (reason: ScanFault['reason']) => JsonStreamError,
  ): Promise<Uint8Array | undefined> => {
    try {
      return await pull();
    } catch (fault) {
      throw fault instanceof ScanFault ? error(fault.reason) : fault;
    }
  };

  try {
    for (;;) {
      const chunk = await pullAs(
        (reason) => new JsonStreamError(reason, leading, 0),
      );
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
  } catch (error) {
    await cancel();
    throw error;
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
        const chunk = pending ?? (await pullAs(error));
        pending = undefined;
        if (chunk === undefined) return false;
        if (taken + chunk.length > maxBytes) throw error('too-large');
        taken += chunk.length;
        bytesSinceYield += chunk.length;
        await maybeYield();
        scanner.push(chunk);
        return true;
      };

      for (;;) {
        if (signal?.aborted === true) throw error('aborted');
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
        itemsSinceYield += 1;
        await maybeYield();
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

  /** The rest of the body as one value. Holds up to `maxBytes` of chunks, then the joined bytes, then the text. */
  async function whole(maxBytes: number): Promise<unknown> {
    const parts: Uint8Array[] = [];
    let taken = leading;
    let held = 0;
    // Where the bytes end, for `truncated`: inside a string or with an open bracket.
    let depth = 0;
    let inString = false;
    let escaped = false;
    let pending = head;
    head = undefined;
    const error = (reason: ScanFault['reason']): JsonStreamError =>
      new JsonStreamError(reason, taken, 0);

    try {
      if (taken > maxBytes) throw error('too-large');
      for (;;) {
        const chunk = pending ?? (await pullAs(error));
        pending = undefined;
        if (chunk === undefined) break;
        if (taken + chunk.length > maxBytes) throw error('too-large');
        taken += chunk.length;
        bytesSinceYield += chunk.length;
        await maybeYield();
        // A copy: a source may reuse its buffer once the next chunk is asked for.
        parts.push(chunk.slice());
        held += chunk.length;
        for (const c of chunk) {
          if (inString) {
            if (escaped) escaped = false;
            else if (c === BACKSLASH) escaped = true;
            else if (c === QUOTE) inString = false;
          } else if (c === QUOTE) inString = true;
          else if (c === OPEN_BRACKET || c === OPEN_BRACE) depth += 1;
          else if (c === CLOSE_BRACKET || c === CLOSE_BRACE) depth -= 1;
        }
      }

      const joined = new Uint8Array(held);
      let at = 0;
      for (const part of parts) {
        joined.set(part, at);
        at += part.length;
      }
      parts.length = 0;
      try {
        return JSON.parse(decoder.decode(joined)) as unknown;
      } catch {
        // The platform's text is dropped (I-10).
        throw error(
          shape === 'empty' || depth > 0 || inString
            ? 'truncated'
            : 'malformed',
        );
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
    async value(maxBytes) {
      const limit = positiveInteger(maxBytes, 'maxBytes');
      if (claimed) throw new Error('The stream was already read.');
      claimed = true;
      return await whole(limit);
    },
    async close() {
      claimed = true;
      head = undefined;
      await cancel();
    },
  };
}
