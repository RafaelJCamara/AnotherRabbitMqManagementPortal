// The canary-secret scanner (I-10, blueprint 13): a test plants known values where a secret could
// leak (a log line, a profile, a header) and the scanner then looks for them in whatever the engine
// produced. A value that was only re-encoded still counts as found, because that is how a leak
// usually looks: JSON-escaped, percent-encoded, hex, or base64 at any of its three alignments.
//
// This is test and gate tooling, not a redactor: it never changes its input and returns where a
// canary was seen, never the canary itself, so a failing assertion does not print the secret.

export type CanaryEncoding =
  | 'raw'
  | 'json'
  | 'url'
  | 'hex'
  | 'base64'
  | 'base64url';

export interface CanaryHit {
  /** Position in the list the scanner was made from. */
  readonly index: number;
  readonly encoding: CanaryEncoding;
}

export interface CanaryScanner {
  /** Every (canary, encoding) pair found in `data`. Text is read as UTF-8 when it is bytes. */
  scan(data: string | Uint8Array): readonly CanaryHit[];
}

/** Shorter values match innocent text by chance, so they cannot be canaries. */
export const MIN_CANARY_LENGTH = 8;

/** One way a value can show up in text. */
export interface EncodedForm {
  readonly encoding: CanaryEncoding;
  readonly text: string;
  /** Hex is compared without regard to case, everything else exactly. */
  readonly fold: boolean;
}

interface Needle extends EncodedForm {
  readonly index: number;
}

/** The base64 text that depends only on the canary's bytes, for each alignment in a stream. */
function base64Windows(
  bytes: Buffer,
  encoding: 'base64' | 'base64url',
): string[] {
  const windows: string[] = [];
  for (let lead = 0; lead < 3; lead += 1) {
    const framed = Buffer.concat([Buffer.alloc(lead), bytes]).toString(
      encoding,
    );
    // Characters that mix in the lead bytes or in the bytes after the canary are left out.
    const from = Math.ceil((8 * lead) / 6);
    const to = Math.floor((8 * (lead + bytes.length)) / 6);
    windows.push(framed.slice(from, to));
  }
  return windows;
}

/**
 * Every form of `value` the scanner looks for: the value itself, JSON-escaped, percent-encoded, hex,
 * and the part of its base64 and base64url text that does not depend on the bytes around it. A
 * redactor that removes all of them leaves nothing the scanner can find.
 */
export function encodedForms(value: string): readonly EncodedForm[] {
  const bytes = Buffer.from(value, 'utf8');
  const forms: EncodedForm[] = [
    { encoding: 'raw', text: value, fold: false },
    {
      encoding: 'json',
      text: JSON.stringify(value).slice(1, -1),
      fold: false,
    },
    { encoding: 'url', text: encodeURIComponent(value), fold: false },
    { encoding: 'hex', text: bytes.toString('hex'), fold: true },
  ];
  for (const encoding of ['base64', 'base64url'] as const) {
    for (const text of base64Windows(bytes, encoding)) {
      forms.push({ encoding, text, fold: false });
    }
  }
  return forms.filter((form) => form.text.length >= 4);
}

export function createCanaryScanner(
  canaries: readonly string[],
): CanaryScanner {
  canaries.forEach((canary, index) => {
    if (canary.length < MIN_CANARY_LENGTH) {
      throw new RangeError(
        `Canary ${String(index)} is shorter than ${String(MIN_CANARY_LENGTH)} characters.`,
      );
    }
  });
  const needles: Needle[] = canaries.flatMap((canary, index) =>
    encodedForms(canary).map((form) => ({ ...form, index })),
  );
  return {
    scan(data) {
      const text =
        typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
      const folded = text.toLowerCase();
      const seen = new Set<string>();
      const hits: CanaryHit[] = [];
      for (const needle of needles) {
        const key = `${String(needle.index)}:${needle.encoding}`;
        if (seen.has(key)) continue;
        const found = needle.fold
          ? folded.includes(needle.text)
          : text.includes(needle.text);
        if (found) {
          seen.add(key);
          hits.push({ index: needle.index, encoding: needle.encoding });
        }
      }
      return hits;
    },
  };
}
