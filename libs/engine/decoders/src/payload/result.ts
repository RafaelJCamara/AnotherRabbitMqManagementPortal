// The structured result of a decode. Everything in it is plain data (it crosses the worker
// boundary by structured clone and becomes JSON), and nothing in it but the view carries payload
// bytes: error messages are fixed phrases (I-10).
import type { CodecErrorCode } from '../codecs/errors.ts';
import type { CodecLimits } from '../codecs/limits.ts';
import type {
  CodecNote,
  PayloadView,
  Truncation,
  ViewCodecId,
} from '../codecs/types.ts';
import type { PayloadRule } from './rules.ts';
import type { Source } from './select.ts';

export interface PayloadInput {
  readonly body: Uint8Array;
  /** The capture had already cut the body (counted and surfaced). */
  readonly bodyTruncated?: boolean;
  /** The AMQP `content_type` property. */
  readonly contentType?: string;
  /** The AMQP `content_encoding` property. */
  readonly contentEncoding?: string;
  /** For per-queue rules. */
  readonly queue?: string;
  readonly rules?: readonly PayloadRule[];
  /** Can only tighten the defaults. */
  readonly limits?: Partial<CodecLimits>;
  /** Show the (decoded-layer) bytes as hex or base64 whatever they are. */
  readonly view?: 'hex' | 'base64';
}

export interface PayloadLayer {
  readonly encoding: string;
  readonly source: 'rule' | 'header' | 'sniff';
  readonly inBytes: number;
  readonly outBytes: number;
}

export interface DecodedPayload {
  /** The codec that produced the view; `raw` for a hex or base64 view of bytes. */
  readonly codec: ViewCodecId;
  readonly detected: {
    readonly type: string;
    readonly mime: string;
    /** 0 to 1. */
    readonly confidence: number;
    readonly source: Source;
  };
  readonly layers: readonly PayloadLayer[];
  readonly view: PayloadView;
  /** Set when the payload could not be decoded as what it is (or was declared to be). */
  readonly error?: {
    readonly code: CodecErrorCode;
    readonly message: string;
    readonly offset?: number;
  };
  readonly notes: readonly CodecNote[];
  readonly truncations: readonly Truncation[];
  readonly counters: {
    readonly inputBytes: number;
    /** The bytes after all encoding layers were undone. */
    readonly decodedBytes: number;
    /** The size of the view's text. */
    readonly viewBytes: number;
  };
}

export function viewBytes(view: PayloadView): number {
  return Buffer.byteLength(view.text, 'utf8');
}
