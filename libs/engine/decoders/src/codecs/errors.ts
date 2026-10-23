// The error catalogue of the codecs. Every message is a fixed phrase chosen by code: an error
// never carries a byte, a character or a key of the payload (I-10), only a code and, where the
// codec knows it, a byte offset.
export const CODEC_MESSAGES = {
  INPUT_LIMIT: 'The payload is larger than the input limit; a prefix is shown.',
  OUTPUT_LIMIT: 'Decompressing would pass the output limit.',
  RATIO_LIMIT: 'The compression ratio is above the limit.',
  LAYER_LIMIT: 'The payload has more encoding layers than the limit.',
  DEPTH_LIMIT: 'The document is nested deeper than the limit.',
  NODE_LIMIT: 'The document has more values than the limit.',
  UNSUPPORTED_ENCODING: 'The content encoding is not supported.',
  UNSUPPORTED_CHARSET: 'The charset is not supported.',
  MALFORMED_TEXT: 'The bytes are not valid text in the charset.',
  MALFORMED_JSON: 'The payload is not valid JSON.',
  MALFORMED_XML: 'The payload is not well-formed XML.',
  MALFORMED_BASE64: 'The payload is not valid base64 text.',
  MALFORMED_HEX: 'The payload is not valid hex text.',
  MALFORMED_COMPRESSED: 'The compressed data is not valid.',
  MALFORMED_MSGPACK: 'The payload is not valid MessagePack.',
  MALFORMED_CBOR: 'The payload is not valid CBOR.',
  MALFORMED_PICKLE: 'The payload is not a readable pickle stream.',
  MALFORMED_PHP: 'The payload is not valid PHP serialize() text.',
  MALFORMED_CLOUDEVENT: 'The JSON is not a valid structured CloudEvent.',
  XML_DOCTYPE: 'The XML has a document type declaration; it is refused.',
  XML_ENTITY: 'The XML uses an entity that is not predefined; it is refused.',
  SOURCE_TRUNCATED: 'The captured body was already cut before decoding.',
  LOSSY_TEXT: 'Some bytes were not valid in the charset and were replaced.',
  INTERNAL: 'The decoder stopped on an internal error.',
} as const;

export type CodecErrorCode = keyof typeof CODEC_MESSAGES;

/** The only error a codec throws on purpose. */
export class CodecError extends Error {
  readonly code: CodecErrorCode;
  readonly offset: number | undefined;

  constructor(code: CodecErrorCode, offset?: number) {
    super(CODEC_MESSAGES[code]);
    this.name = 'CodecError';
    this.code = code;
    this.offset = offset;
  }
}

export function fail(code: CodecErrorCode, offset?: number): never {
  throw new CodecError(code, offset);
}

/** Any thrown value as a catalogue code; unknown throws are `INTERNAL`. */
export function codeOf(error: unknown): {
  code: CodecErrorCode;
  offset: number | undefined;
} {
  if (error instanceof CodecError) {
    return { code: error.code, offset: error.offset };
  }
  return { code: 'INTERNAL', offset: undefined };
}
