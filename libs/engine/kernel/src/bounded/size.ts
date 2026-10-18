// How big an item is, in bytes. Both bounds of I-6 (items and bytes) need a size per item.

export type SizeOf<T> = (item: T) => number;

/** The size of a string (UTF-8) or of binary data. Anything else needs an explicit `sizeOf`. */
export function binarySizeOf(item: unknown): number {
  if (typeof item === 'string') return Buffer.byteLength(item, 'utf8');
  if (item instanceof ArrayBuffer) return item.byteLength;
  if (ArrayBuffer.isView(item)) return item.byteLength;
  throw new TypeError(
    'Bounded collections need a sizeOf(item) option for items that are not strings or binary data.',
  );
}

/** A size is a non-negative safe integer; a wrong size would silently break the byte bound. */
export function checkedSize<T>(sizeOf: SizeOf<T>, item: T): number {
  const size = sizeOf(item);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new RangeError(
      `sizeOf(item) must return a non-negative safe integer; got ${String(size)}.`,
    );
  }
  return size;
}

export function assertLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}
