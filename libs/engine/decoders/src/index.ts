// @app/decoders: payload codecs (M1-10, MSG-08) and the built-in framework decoders (DC-53).
export type {
  DecodeInput,
  DecoderPlugin,
  NormalizedFailure,
  TypedHeaderValue,
} from './types.ts';
export { builtinDecoders } from './builtin/index.ts';

export { CODEC_MESSAGES, type CodecErrorCode } from './codecs/errors.ts';
export { DEFAULT_LIMITS, type CodecLimits } from './codecs/limits.ts';
export { FORMAT_CODECS, TRANSFORM_CODECS } from './codecs/registry.ts';
export type {
  CodecId,
  CodecNote,
  CodecPlugin,
  FormatCodec,
  FormatCodecId,
  JsonValue,
  PayloadView,
  TransformCodec,
  TransformCodecId,
  Truncation,
  TruncationKind,
  ViewCodecId,
} from './codecs/types.ts';
export { decodePayload, encodePayload } from './payload/decode-payload.ts';
export type {
  DecodedPayload,
  PayloadInput,
  PayloadLayer,
} from './payload/result.ts';
export { matchRule, queueMatches, type PayloadRule } from './payload/rules.ts';
export {
  codecPoolOptions,
  codecWorkerUrl,
  type CodecPoolOptions,
} from './worker-url.ts';
