// Bytes to text with a charset hint: a BOM, a declared charset, or a UTF-16 pattern.
import { fail } from './errors.ts';

export interface DecodedText {
  readonly text: string;
  readonly charset: string;
  /** The bytes of the body that the text covers (after the BOM, before any cut). */
  readonly usedBytes: number;
  /** The bytes of the body left out by the byte cap. */
  readonly cutBytes: number;
  /** Characters replaced because the bytes were not valid in the charset. */
  readonly replacements: number;
}

export interface DecodeTextOptions {
  /** A label from the content type or a rule. */
  readonly declared?: string | undefined;
  readonly maxBytes: number;
  /** When true, invalid bytes become U+FFFD instead of an error. */
  readonly lossy: boolean;
}

/** The canonical name of a charset label, or undefined when the platform does not know it. */
export function canonicalCharset(label: string): string | undefined {
  try {
    return new TextDecoder(label).encoding;
  } catch {
    return undefined;
  }
}

interface Bom {
  readonly charset: string;
  readonly length: number;
}

export function bomOf(bytes: Uint8Array): Bom | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { charset: 'utf-8', length: 3 };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { charset: 'utf-16le', length: 2 };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { charset: 'utf-16be', length: 2 };
  }
  return undefined;
}

/** UTF-16 without a BOM shows as a NUL in every other byte of mostly-ASCII text. */
export function utf16Pattern(sample: Uint8Array): string | undefined {
  const pairs = Math.min(sample.length >> 1, 256);
  if (pairs < 4) return undefined;
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < pairs; i++) {
    if (sample[2 * i] === 0) evenZero++;
    if (sample[2 * i + 1] === 0) oddZero++;
  }
  if (oddZero * 10 >= pairs * 9 && evenZero === 0) return 'utf-16le';
  if (evenZero * 10 >= pairs * 9 && oddZero === 0) return 'utf-16be';
  return undefined;
}

/** Where to cut `length` bytes of `bytes` so that no character is split. */
function cutPoint(
  bytes: Uint8Array,
  start: number,
  length: number,
  max: number,
  charset: string,
): number {
  if (length <= max) return length;
  let use = max;
  if (charset === 'utf-8') {
    while (use > 0 && ((bytes[start + use] ?? 0) & 0xc0) === 0x80) use--;
  } else if (charset === 'utf-16le' || charset === 'utf-16be') {
    use -= use % 2;
  }
  return use;
}

export function decodeText(
  bytes: Uint8Array,
  options: DecodeTextOptions,
): DecodedText {
  const bom = bomOf(bytes);
  let charset: string;
  if (bom !== undefined) {
    charset = bom.charset;
  } else if (options.declared !== undefined) {
    const known = canonicalCharset(options.declared);
    if (known === undefined) return fail('UNSUPPORTED_CHARSET');
    charset = known;
  } else {
    charset = utf16Pattern(bytes.subarray(0, 512)) ?? 'utf-8';
  }
  const start = bom?.length ?? 0;
  const available = bytes.length - start;
  const use = cutPoint(bytes, start, available, options.maxBytes, charset);
  const slice = bytes.subarray(start, start + use);
  let text: string;
  let replacements = 0;
  try {
    text = new TextDecoder(charset, { fatal: true }).decode(slice);
  } catch {
    if (!options.lossy) return fail('MALFORMED_TEXT');
    text = new TextDecoder(charset, { fatal: false }).decode(slice);
    for (let at = text.indexOf('�'); at !== -1; ) {
      replacements++;
      at = text.indexOf('�', at + 1);
    }
  }
  return {
    text,
    charset,
    usedBytes: use,
    cutBytes: available - use,
    replacements,
  };
}
