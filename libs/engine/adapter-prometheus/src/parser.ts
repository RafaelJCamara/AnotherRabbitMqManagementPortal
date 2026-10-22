// The Prometheus text exposition format, read as a stream with bounded memory (DC-33, I-5, I-6).
//
// A body is a sequence of lines: `# HELP`, `# TYPE`, `name{label="value",...} value [timestamp]`.
// The parser decodes chunks as they arrive (a character split across two chunks is kept whole),
// cuts lines, drops the families the caller does not want before it allocates anything for them, and
// hands each wanted sample to a sink. What it holds is the current chunk and the unfinished line
// (at most `maxLineBytes`); a longer line is skipped to its end and counted, and a body past
// `maxBodyBytes` ends the read. It never builds the list of samples: the sink decides what to keep.
//
// It gives the event loop a turn every `yieldEveryBytes` of text and every `yieldEveryLines` lines
// (I-5), also inside one very large chunk, so a 100 MB page cannot hold the loop. `yieldNow` is
// injectable so the rule is testable without a clock.
import { PromScrapeError } from './errors.ts';

export interface PromSample {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
  /** Milliseconds since the epoch, when the exposition gave one. */
  readonly timestamp?: number;
}

export interface ParseOptions {
  /** Keeps a family: asked with the metric name before its labels are read. Default: all. */
  readonly wanted?: (name: string) => boolean;
  /** Called for `# TYPE name type`, for every family (wanted or not is the callee's business). */
  readonly onType?: (name: string, type: string) => void;
  /** The longest line kept, in characters. A longer line is skipped and counted. Default 64 KiB. */
  readonly maxLineBytes?: number;
  /** The most bytes taken from the source. A bigger body fails the read. Default 256 MiB. */
  readonly maxBodyBytes?: number;
  /** The most samples delivered. At the limit the read stops and `truncated` is `samples`. Default 1,000,000. */
  readonly maxSamples?: number;
  /** The most labels of one sample; a sample with more is counted as malformed. Default 64. */
  readonly maxLabels?: number;
  readonly yieldEveryBytes?: number;
  readonly yieldEveryLines?: number;
  readonly yieldNow?: () => Promise<void>;
  readonly signal?: AbortSignal;
}

export interface ParseSummary {
  readonly bytes: number;
  readonly lines: number;
  /** Samples handed to the sink. */
  readonly samples: number;
  /** Sample lines of a family the caller did not want. */
  readonly skipped: number;
  /** Lines that are not valid exposition; they are dropped, not guessed at. */
  readonly malformed: number;
  /** Lines over `maxLineBytes`, dropped. */
  readonly oversizedLines: number;
  /** Why the read stopped before the end of the body, if it did. */
  readonly truncated?: 'samples';
  /** The turns given to the event loop, and the most text and lines between two of them. */
  readonly yields: number;
  readonly maxCharsBetweenYields: number;
  readonly maxLinesBetweenYields: number;
}

export const DEFAULT_PARSE_LIMITS = {
  maxLineBytes: 64 * 1024,
  maxBodyBytes: 256 * 1024 * 1024,
  maxSamples: 1_000_000,
  maxLabels: 64,
  yieldEveryBytes: 256 * 1024,
  yieldEveryLines: 5_000,
} as const;

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[A-Za-z0-9_:]/;
const LABEL_START = /[A-Za-z_]/;
const LABEL_CHAR = /[A-Za-z0-9_]/;
const FLOAT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const INTEGER = /^[+-]?\d+$/;
const BLANK = /[ \t]/;

/** A value token: a float, `NaN` or an infinity; undefined when it is none of those. */
function parseValue(token: string): number | undefined {
  if (FLOAT.test(token)) return Number(token);
  switch (token) {
    case 'NaN':
    case 'nan':
      return Number.NaN;
    case '+Inf':
    case 'Inf':
    case '+inf':
    case 'inf':
      return Number.POSITIVE_INFINITY;
    case '-Inf':
    case '-inf':
      return Number.NEGATIVE_INFINITY;
    default:
      return undefined;
  }
}

type Line =
  | { readonly kind: 'skip' }
  | { readonly kind: 'type'; readonly name: string; readonly type: string }
  | { readonly kind: 'filtered' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'sample'; readonly sample: PromSample };

const SKIP: Line = { kind: 'skip' };
const FILTERED: Line = { kind: 'filtered' };
const MALFORMED: Line = { kind: 'malformed' };

function parseLabels(
  line: string,
  start: number,
  maxLabels: number,
): { labels: Record<string, string>; end: number } | undefined {
  const labels: Record<string, string> = {};
  let count = 0;
  let i = start;
  for (;;) {
    while (i < line.length && (BLANK.test(line.charAt(i)) || line[i] === ','))
      i++;
    if (i >= line.length) return undefined;
    if (line[i] === '}') return { labels, end: i + 1 };
    if (!LABEL_START.test(line.charAt(i))) return undefined;
    const nameStart = i;
    while (i < line.length && LABEL_CHAR.test(line.charAt(i))) i++;
    const name = line.slice(nameStart, i);
    while (i < line.length && BLANK.test(line.charAt(i))) i++;
    if (line[i] !== '=') return undefined;
    i++;
    while (i < line.length && BLANK.test(line.charAt(i))) i++;
    if (line[i] !== '"') return undefined;
    i++;
    let value = '';
    let closed = false;
    while (i < line.length) {
      const char = line.charAt(i);
      if (char === '"') {
        closed = true;
        i++;
        break;
      }
      if (char === '\\') {
        const next = line.charAt(i + 1);
        if (next === '') return undefined;
        value += next === 'n' ? '\n' : next;
        i += 2;
      } else {
        value += char;
        i++;
      }
    }
    if (!closed) return undefined;
    if (++count > maxLabels) return undefined;
    labels[name] = value;
  }
}

function parseLine(
  raw: string,
  options: { wanted: (name: string) => boolean; maxLabels: number },
): Line {
  const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  let i = 0;
  while (i < line.length && BLANK.test(line.charAt(i))) i++;
  if (i >= line.length) return SKIP;
  if (line[i] === '#') {
    const parts = line
      .slice(i + 1)
      .trim()
      .split(/[ \t]+/);
    if (
      parts[0] === 'TYPE' &&
      parts[1] !== undefined &&
      parts[2] !== undefined
    ) {
      return { kind: 'type', name: parts[1], type: parts[2] };
    }
    return SKIP;
  }
  if (!NAME_START.test(line.charAt(i))) return MALFORMED;
  const nameStart = i;
  while (i < line.length && NAME_CHAR.test(line.charAt(i))) i++;
  const name = line.slice(nameStart, i);
  if (!options.wanted(name)) return FILTERED;
  let labels: Record<string, string> = {};
  if (line[i] === '{') {
    const read = parseLabels(line, i + 1, options.maxLabels);
    if (read === undefined) return MALFORMED;
    labels = read.labels;
    i = read.end;
  }
  if (i >= line.length || !BLANK.test(line.charAt(i))) return MALFORMED;
  const tokens = line
    .slice(i)
    .trim()
    .split(/[ \t]+/);
  const [valueToken, timestampToken, extra] = tokens;
  if (valueToken === undefined || extra !== undefined) return MALFORMED;
  const value = parseValue(valueToken);
  if (value === undefined) return MALFORMED;
  if (timestampToken === undefined) {
    return { kind: 'sample', sample: { name, labels, value } };
  }
  if (!INTEGER.test(timestampToken)) return MALFORMED;
  return {
    kind: 'sample',
    sample: { name, labels, value, timestamp: Number(timestampToken) },
  };
}

const nextTurn = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const aborted = (): PromScrapeError =>
  new PromScrapeError('aborted', 'the metrics read was aborted');

/**
 * Reads an exposition body. Resolves with the counts; rejects with `PromScrapeError`
 * (`response-too-large`, `aborted`, `unexpected-body` for a body that is not exposition at all).
 * The source is always settled: read to its end, or cancelled with `return()` when the read stops
 * early, so an HTTP body is closed and the scheduler's slot is given back.
 */
export async function parseExposition(
  source: AsyncIterable<Uint8Array>,
  sink: (sample: PromSample) => void,
  options: ParseOptions = {},
): Promise<ParseSummary> {
  const limits = { ...DEFAULT_PARSE_LIMITS, ...options };
  const wanted = options.wanted ?? (() => true);
  const yieldNow = options.yieldNow ?? nextTurn;
  const decoder = new TextDecoder('utf-8', { fatal: false });

  let bytes = 0;
  let lines = 0;
  let samples = 0;
  let skipped = 0;
  let malformed = 0;
  let oversized = 0;
  let yields = 0;
  let charsSince = 0;
  let linesSince = 0;
  let maxChars = 0;
  let maxLines = 0;
  let truncated: ParseSummary['truncated'];
  let carry = '';
  let skipping = false;

  // A function, not an expression: the signal changes across the awaits below.
  const wasAborted = (): boolean => options.signal?.aborted === true;

  const takeTurn = async (): Promise<void> => {
    maxChars = Math.max(maxChars, charsSince);
    maxLines = Math.max(maxLines, linesSince);
    charsSince = 0;
    linesSince = 0;
    yields++;
    await yieldNow();
    if (wasAborted()) throw aborted();
  };

  /** Handles one complete line; true when the read must stop. */
  const handle = (text: string): boolean => {
    lines++;
    linesSince++;
    const parsed = parseLine(text, { wanted, maxLabels: limits.maxLabels });
    switch (parsed.kind) {
      case 'skip':
        return false;
      case 'type':
        options.onType?.(parsed.name, parsed.type);
        return false;
      case 'filtered':
        skipped++;
        return false;
      case 'malformed':
        malformed++;
        return false;
      case 'sample':
        sink(parsed.sample);
        samples++;
        if (samples >= limits.maxSamples) {
          truncated = 'samples';
          return true;
        }
        return false;
    }
  };

  const iterator = source[Symbol.asyncIterator]();
  let finished = false;
  try {
    if (wasAborted()) throw aborted();
    read: for (;;) {
      const next = await iterator.next();
      if (next.done === true) {
        finished = true;
        break;
      }
      const chunk = next.value;
      bytes += chunk.byteLength;
      if (bytes > limits.maxBodyBytes) {
        throw new PromScrapeError(
          'response-too-large',
          `the metrics body is larger than ${String(limits.maxBodyBytes)} bytes`,
        );
      }
      const text = decoder.decode(chunk, { stream: true });
      let from = 0;
      while (from < text.length) {
        const newline = text.indexOf('\n', from);
        const end = newline === -1 ? text.length : newline;
        const piece = text.slice(from, end);
        charsSince += piece.length + 1;
        if (skipping) {
          // The rest of an oversized line: dropped up to its end.
          if (newline !== -1) skipping = false;
        } else if (newline === -1) {
          if (carry.length + piece.length > limits.maxLineBytes) {
            oversized++;
            skipping = true;
            carry = '';
          } else {
            carry += piece;
          }
        } else {
          const whole = carry === '' ? piece : carry + piece;
          carry = '';
          if (whole.length > limits.maxLineBytes) oversized++;
          else if (handle(whole)) break read;
        }
        from = end + 1;
        if (
          charsSince >= limits.yieldEveryBytes ||
          linesSince >= limits.yieldEveryLines
        ) {
          await takeTurn();
        }
      }
      if (wasAborted()) throw aborted();
    }
    if (finished) {
      const tail = carry + decoder.decode();
      carry = '';
      if (tail !== '' && !skipping) {
        if (tail.length > limits.maxLineBytes) oversized++;
        else handle(tail);
      }
    }
  } finally {
    if (!finished) {
      // Stopped early (a cap, an abort, an error): cancel the source; do not wait on it.
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
    }
  }
  maxChars = Math.max(maxChars, charsSince);
  maxLines = Math.max(maxLines, linesSince);
  // A body of only malformed lines is not an exposition (an HTML error page, a proxy banner).
  if (samples === 0 && skipped === 0 && malformed > 0) {
    throw new PromScrapeError(
      'unexpected-body',
      'the answer is not a Prometheus text exposition',
    );
  }
  return {
    bytes,
    lines,
    samples,
    skipped,
    malformed,
    oversizedLines: oversized,
    ...(truncated === undefined ? {} : { truncated }),
    yields,
    maxCharsBetweenYields: maxChars,
    maxLinesBetweenYields: maxLines,
  };
}
