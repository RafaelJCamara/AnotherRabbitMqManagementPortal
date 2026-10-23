// The shapes of a payload codec (blueprint 11, `CodecPlugin {detect, decode, encode?}`).
//
// This file and everything the worker loads imports only relative `.ts` files and `node:`
// built-ins: Node starts the worker itself and cannot resolve the `@app/*` aliases (M1-10).
import type { CodecErrorCode } from './errors.ts';
import type { CodecLimits } from './limits.ts';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Codecs that turn the bytes of a body into text, a tree or a listing. */
export type FormatCodecId =
  | 'text'
  | 'json'
  | 'xml'
  | 'msgpack'
  | 'cbor'
  | 'cloudevents'
  | 'pickle'
  | 'php';

/** Codecs that turn bytes into other bytes (a content encoding or a text encoding of bytes). */
export type TransformCodecId =
  | 'gzip'
  | 'deflate'
  | 'brotli'
  | 'zstd'
  | 'base64'
  | 'hex';

export type CodecId = FormatCodecId | TransformCodecId;
/** `raw` is the hex and base64 views of bytes that no format codec produced. */
export type ViewCodecId = FormatCodecId | 'raw';

/** What a limit cut, so a consumer can say so (I-6, I-13). `dropped` is null when not known. */
export type TruncationKind =
  | 'source' // the capture had already cut the body
  | 'preview' // a hex or base64 view shows a prefix
  | 'view' // text or a tree was cut at the view cap
  | 'depth' // the tree was dropped: nesting above the limit
  | 'nodes'; // the tree was dropped: more nodes than the limit

export interface Truncation {
  readonly what: TruncationKind;
  readonly max: number;
  readonly dropped: number | null;
}

export type PayloadView =
  | {
      readonly kind: 'tree';
      readonly value: JsonValue;
      /** The pretty text of the same document (it keeps number lexemes of JSON). */
      readonly text: string;
    }
  | { readonly kind: 'text'; readonly text: string; readonly charset: string }
  | {
      readonly kind: 'hex';
      readonly text: string;
      readonly shownBytes: number;
      readonly totalBytes: number;
    }
  | {
      readonly kind: 'base64';
      readonly text: string;
      readonly shownBytes: number;
      readonly totalBytes: number;
    }
  | {
      readonly kind: 'disassembly';
      readonly text: string;
      /** Always false: pickle and PHP payloads are never loaded (blueprint 11). */
      readonly deserialised: false;
    };

/** A non-fatal remark, a fixed phrase chosen by code. Never payload bytes. */
export interface CodecNote {
  readonly code: CodecErrorCode;
  readonly detail?: number;
}

export interface DecodeContext {
  readonly limits: CodecLimits;
  /** A charset label from the content type or a rule (lower case), if any. */
  readonly charset?: string;
}

export interface FormatOutput {
  readonly view: PayloadView;
  /** The detected type (`json`, `msgpack`, ...). */
  readonly type: string;
  readonly mime: string;
  readonly truncations: readonly Truncation[];
  readonly notes: readonly CodecNote[];
}

export interface FormatCodec {
  readonly kind: 'format';
  readonly id: FormatCodecId;
  /** Content-type mimes (and `+suffix` forms) that select it. Lower case. */
  readonly mimes: readonly string[];
  /** 0 means "not this format". Looks at a sample only; `decode` is the judge. */
  detect(sample: Uint8Array): number;
  /** Throws a `CodecError` on a payload that is not this format. */
  decode(bytes: Uint8Array, context: DecodeContext): FormatOutput;
  encode?(value: unknown): Uint8Array;
}

export interface TransformOutput {
  readonly bytes: Uint8Array;
}

export interface TransformCodec {
  readonly kind: 'transform';
  readonly id: TransformCodecId;
  /** The `content-encoding` tokens that select it. Lower case. */
  readonly encodings: readonly string[];
  /** Sniffed by magic number only; a text encoding of bytes returns 0. */
  detect(sample: Uint8Array): number;
  decode(bytes: Uint8Array, context: DecodeContext): TransformOutput;
  encode?(bytes: Uint8Array): Uint8Array;
}

export type CodecPlugin = FormatCodec | TransformCodec;

export type { CodecErrorCode, CodecLimits };
