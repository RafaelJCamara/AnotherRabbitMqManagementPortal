// Selection: which encodings to undo and which format codecs to try, in what order and why.
// Order of authority (OQ-1205): a rule, then the headers, then a sniff of the bytes, then hex.
import { canonicalCharset } from '../codecs/charset.ts';
import {
  formatCodec,
  formatCodecsForMime,
  isGenericMime,
  sniffFormats,
  transformForEncoding,
} from '../codecs/registry.ts';
import type {
  CodecNote,
  FormatCodec,
  TransformCodec,
} from '../codecs/types.ts';
import type { PayloadRule } from './rules.ts';

export type Source = 'rule' | 'header' | 'sniff' | 'fallback';

export interface ParsedContentType {
  readonly mime?: string;
  readonly charset?: string;
}

const MAX_HEADER = 512;
const MAX_TOKENS = 8;

export function parseContentType(value: unknown): ParsedContentType {
  if (typeof value !== 'string') return {};
  const parts = value.slice(0, MAX_HEADER).split(';');
  const mime = (parts[0] ?? '').trim().toLowerCase();
  let charset: string | undefined;
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim().toLowerCase() !== 'charset') continue;
    const raw = part.slice(eq + 1).trim();
    charset = raw.replace(/^"|"$/g, '').toLowerCase();
  }
  return {
    ...(mime === '' || !mime.includes('/') ? {} : { mime }),
    ...(charset === undefined || charset === '' ? {} : { charset }),
  };
}

export interface ParsedEncodings {
  /** In the order they must be undone (the reverse of the header). */
  readonly transforms: readonly TransformCodec[];
  /** A charset name that the sender put in `content-encoding` (`utf-8`). */
  readonly charset?: string;
  readonly notes: readonly CodecNote[];
}

export function parseEncodings(value: unknown): ParsedEncodings {
  const notes: CodecNote[] = [];
  const found: TransformCodec[] = [];
  let charset: string | undefined;
  if (typeof value === 'string') {
    const tokens = value
      .slice(0, MAX_HEADER)
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== '' && token !== 'identity')
      .slice(0, MAX_TOKENS);
    for (const token of tokens) {
      const codec = transformForEncoding(token);
      if (codec !== undefined) {
        found.push(codec);
      } else if (canonicalCharset(token) !== undefined) {
        // Many clients put a charset in content-encoding; it is a hint, not a transform.
        charset = token;
      } else {
        notes.push({ code: 'UNSUPPORTED_ENCODING' });
      }
    }
  }
  return {
    transforms: found.reverse(),
    ...(charset === undefined ? {} : { charset }),
    notes,
  };
}

export interface Candidate {
  readonly codec: FormatCodec;
  readonly source: Exclude<Source, 'fallback'>;
  readonly confidence: number;
}

export interface FormatPlan {
  /** From a rule or a specific content type. When all fail the payload is shown as hex. */
  readonly primary: readonly Candidate[];
  /** From the bytes. Tried only when `primary` is empty; failures are notes. */
  readonly sniffed: readonly Candidate[];
}

export function planFormats(
  rule: PayloadRule | undefined,
  mime: string | undefined,
  sample: Uint8Array,
  charset: string | undefined,
): FormatPlan {
  const primary: Candidate[] = [];
  if (rule?.codec !== undefined) {
    const codec = formatCodec(rule.codec);
    if (codec !== undefined)
      primary.push({ codec, source: 'rule', confidence: 1 });
  } else if (mime !== undefined && !isGenericMime(mime)) {
    for (const codec of formatCodecsForMime(mime)) {
      primary.push({ codec, source: 'header', confidence: 0.95 });
    }
  }
  const sniffed: Candidate[] = [];
  if (primary.length === 0) {
    for (const { codec, confidence } of sniffFormats(sample, 3)) {
      sniffed.push({ codec, source: 'sniff', confidence });
    }
    // A text type, or a declared charset, with bytes nothing else claims is still text.
    if (
      ((mime?.startsWith('text/') ?? false) || charset !== undefined) &&
      !sniffed.some((candidate) => candidate.codec.id === 'text')
    ) {
      const text = formatCodec('text');
      if (text !== undefined) {
        sniffed.push({ codec: text, source: 'header', confidence: 0.6 });
      }
    }
  }
  return { primary, sniffed };
}
