/** Why a read of a JSON array failed. One fixed text per reason, see `REASON_TEXT`. */
export type JsonStreamReason =
  | 'not-an-array' // array() on a body whose first significant byte is not `[`
  | 'malformed' // not JSON where the array requires it (bad item, bad separator, bad UTF-8)
  | 'truncated' // the source ended before the closing bracket
  | 'too-large' // maxBytes, maxItemBytes or a value() ceiling passed
  | 'too-deep' // nesting inside one item deeper than maxDepth
  | 'trailing-data' // a non-blank byte after the closing bracket
  | 'aborted'; // the signal fired

/** The only texts an error of this project carries. None of them can hold an input byte (I-10). */
export const REASON_TEXT: Readonly<Record<JsonStreamReason, string>> = {
  'not-an-array': 'The JSON value is not an array.',
  malformed: 'The JSON array is malformed.',
  truncated: 'The JSON array ended before its closing bracket.',
  'too-large': 'The JSON array is larger than the limit.',
  'too-deep': 'An item of the JSON array is nested deeper than the limit.',
  'trailing-data': 'Data follows the closing bracket of the JSON array.',
  aborted: 'The read of the JSON array was aborted.',
};

export class JsonStreamError extends Error {
  readonly reason: JsonStreamReason;
  /** Bytes taken from the source when the fault was found. A position, never content. */
  readonly offset: number;
  /** Items delivered before the fault. */
  readonly delivered: number;

  constructor(reason: JsonStreamReason, offset: number, delivered: number) {
    super(REASON_TEXT[reason]);
    this.name = 'JsonStreamError';
    this.reason = reason;
    this.offset = offset;
    this.delivered = delivered;
  }
}
