// The decode pipeline: undo the encoding layers, pick a format codec, build the view. Pure and
// synchronous (the pool runs it off the main loop), bounded in input, output, depth and layers,
// and it never throws: whatever goes wrong becomes a hex view and a coded error (MSG-08).
import {
  CODEC_MESSAGES,
  codeOf,
  fail,
  type CodecErrorCode,
} from '../codecs/errors.ts';
import { tightenLimits, type CodecLimits } from '../codecs/limits.ts';
import {
  formatCodec,
  sniffTransform,
  transformCodec,
} from '../codecs/registry.ts';
import type {
  CodecNote,
  DecodeContext,
  CodecId,
  FormatCodecId,
  TransformCodecId,
  FormatOutput,
  PayloadView,
  TransformCodec,
  Truncation,
} from '../codecs/types.ts';
import { base64View, fitUtf8, hexDump } from '../codecs/views.ts';
import {
  viewBytes,
  type DecodedPayload,
  type PayloadInput,
  type PayloadLayer,
} from './result.ts';
import { matchRule } from './rules.ts';
import {
  parseContentType,
  parseEncodings,
  planFormats,
  type Candidate,
  type Source,
} from './select.ts';

const SNIFF_SAMPLE = 4096;

interface State {
  readonly notes: CodecNote[];
  readonly truncations: Truncation[];
  readonly layers: PayloadLayer[];
}

interface Declared {
  readonly type: string;
  readonly mime: string;
  readonly source: Source;
}

function errorOf(
  code: CodecErrorCode,
  offset: number | undefined,
): NonNullable<DecodedPayload['error']> {
  return {
    code,
    message: CODEC_MESSAGES[code],
    ...(offset === undefined ? {} : { offset }),
  };
}

/** A hex or base64 view of bytes, the prefix cut to the limits and the rest counted. */
function rawView(
  bytes: Uint8Array,
  kind: 'hex' | 'base64',
  limits: CodecLimits,
  truncations: Truncation[],
): PayloadView {
  // Whole rows only, so that the text never passes the view cap: a hex row is 78 characters for
  // 16 bytes, a base64 row 76 for 57, plus a line break.
  const room =
    kind === 'hex'
      ? Math.floor((limits.maxViewBytes + 1) / 79) * 16
      : Math.floor((limits.maxViewBytes + 1) / 77) * 57;
  const shown = Math.max(0, Math.min(bytes.length, limits.previewBytes, room));
  if (shown < bytes.length) {
    truncations.push({
      what: 'preview',
      max: shown,
      dropped: bytes.length - shown,
    });
  }
  const text =
    kind === 'hex' ? hexDump(bytes, shown) : base64View(bytes, shown);
  return { kind, text, shownBytes: shown, totalBytes: bytes.length };
}

function rawResult(
  bytes: Uint8Array,
  inputBytes: number,
  limits: CodecLimits,
  state: State,
  options: {
    readonly kind?: 'hex' | 'base64';
    readonly error?: NonNullable<DecodedPayload['error']>;
    readonly declared?: Declared;
  },
): DecodedPayload {
  const view = rawView(bytes, options.kind ?? 'hex', limits, state.truncations);
  const declared = options.declared;
  return {
    codec: 'raw',
    detected: {
      type: declared?.type ?? 'binary',
      mime: declared?.mime ?? 'application/octet-stream',
      confidence: 0,
      source: declared?.source ?? 'fallback',
    },
    layers: state.layers,
    view,
    ...(options.error === undefined ? {} : { error: options.error }),
    notes: state.notes,
    truncations: state.truncations,
    counters: {
      inputBytes,
      decodedBytes: bytes.length,
      viewBytes: viewBytes(view),
    },
  };
}

/** A codec's view, held to the view cap whatever the codec did. */
function capView(
  output: FormatOutput,
  limits: CodecLimits,
  truncations: Truncation[],
): PayloadView {
  const { view } = output;
  if (view.kind === 'hex' || view.kind === 'base64') return view;
  if (Buffer.byteLength(view.text, 'utf8') <= limits.maxViewBytes) return view;
  const fitted = fitUtf8(view.text, limits.maxViewBytes);
  truncations.push({
    what: 'view',
    max: limits.maxViewBytes,
    dropped: fitted.cutChars,
  });
  return view.kind === 'disassembly'
    ? { kind: 'disassembly', text: fitted.text, deserialised: false }
    : { kind: 'text', text: fitted.text, charset: 'utf-8' };
}

function undoLayer(
  codec: TransformCodec,
  bytes: Uint8Array,
  source: PayloadLayer['source'],
  context: DecodeContext,
  state: State,
): Uint8Array {
  if (state.layers.length >= context.limits.maxLayers)
    return fail('LAYER_LIMIT');
  const out = codec.decode(bytes, context).bytes;
  state.layers.push({
    encoding: codec.id,
    source,
    inBytes: bytes.length,
    outBytes: out.length,
  });
  return out;
}

function run(input: PayloadInput): DecodedPayload {
  const limits = tightenLimits(input.limits);
  const body: Uint8Array =
    (input.body as unknown) instanceof Uint8Array
      ? input.body
      : new Uint8Array(0);
  const state: State = { notes: [], truncations: [], layers: [] };
  const inputBytes = body.length;
  if (input.bodyTruncated === true) {
    state.truncations.push({ what: 'source', max: inputBytes, dropped: null });
    state.notes.push({ code: 'SOURCE_TRUNCATED' });
  }
  if (inputBytes > limits.maxInputBytes) {
    return rawResult(body, inputBytes, limits, state, {
      error: errorOf('INPUT_LIMIT', undefined),
    });
  }

  const contentType = parseContentType(input.contentType);
  const rule = matchRule(input.rules, input.queue);
  const encodings = parseEncodings(rule?.encoding ?? input.contentEncoding);
  state.notes.push(...encodings.notes);
  const charset = rule?.charset ?? contentType.charset ?? encodings.charset;
  const context: DecodeContext = {
    limits,
    ...(charset === undefined ? {} : { charset }),
  };

  // 1. Undo the encodings: the declared ones in order, then any a magic number reveals.
  let current = body;
  try {
    const declaredSource = rule?.encoding === undefined ? 'header' : 'rule';
    if (current.length > 0) {
      for (const codec of encodings.transforms) {
        current = undoLayer(codec, current, declaredSource, context, state);
      }
    }
    for (;;) {
      const codec = sniffTransform(current.subarray(0, 16));
      if (codec === undefined) break;
      current = undoLayer(codec, current, 'sniff', context, state);
    }
  } catch (error) {
    const { code, offset } = codeOf(error);
    return rawResult(current, inputBytes, limits, state, {
      error: errorOf(code, offset),
    });
  }

  // 2. A view the caller or a rule asked for, whatever the bytes are.
  const forced = rule?.view ?? input.view;
  if (forced === 'hex' || forced === 'base64') {
    return rawResult(current, inputBytes, limits, state, { kind: forced });
  }

  // 3. An empty body is empty, not an error.
  if (current.length === 0) {
    const view: PayloadView = { kind: 'text', text: '', charset: 'utf-8' };
    return {
      codec: 'text',
      detected: {
        type: 'empty',
        mime: 'text/plain',
        confidence: 1,
        source: 'sniff',
      },
      layers: state.layers,
      view,
      notes: state.notes,
      truncations: state.truncations,
      counters: { inputBytes, decodedBytes: 0, viewBytes: 0 },
    };
  }

  // 4. The format: a rule or a specific content type is trusted; otherwise the bytes decide.
  const plan = planFormats(
    rule,
    contentType.mime,
    current.subarray(0, SNIFF_SAMPLE),
    charset,
  );
  const candidates: readonly Candidate[] =
    plan.primary.length > 0 ? plan.primary : plan.sniffed;
  let firstError:
    | { code: CodecErrorCode; offset: number | undefined }
    | undefined;
  let firstConfidence = 0;
  for (const candidate of candidates) {
    try {
      const output = candidate.codec.decode(current, context);
      const truncations = [...state.truncations, ...output.truncations];
      const view = capView(output, limits, truncations);
      return {
        codec: candidate.codec.id,
        detected: {
          type: output.type,
          mime: output.mime,
          confidence: candidate.confidence,
          source: candidate.source,
        },
        layers: state.layers,
        view,
        notes: [...state.notes, ...output.notes],
        truncations,
        counters: {
          inputBytes,
          decodedBytes: current.length,
          viewBytes: viewBytes(view),
        },
      };
    } catch (error) {
      const failure = codeOf(error);
      if (firstError === undefined) {
        firstError = failure;
        firstConfidence = candidate.confidence;
      }
      if (candidate.source === 'sniff')
        state.notes.push({ code: failure.code });
    }
  }

  // 5. Nothing decoded it: hex, and the reason when the sender or the bytes made a claim.
  const first = candidates[0];
  const declared: Declared | undefined =
    first !== undefined && first.source !== 'sniff'
      ? {
          type: first.codec.id,
          mime: first.codec.mimes[0] ?? 'application/octet-stream',
          source: first.source,
        }
      : undefined;
  const unsupported = state.notes.some(
    (note) => note.code === 'UNSUPPORTED_ENCODING',
  );
  const error =
    firstError !== undefined &&
    (first?.source !== 'sniff' ||
      firstConfidence >= 0.6 ||
      firstError.code === 'UNSUPPORTED_CHARSET')
      ? errorOf(firstError.code, firstError.offset)
      : unsupported
        ? errorOf('UNSUPPORTED_ENCODING', undefined)
        : undefined;
  return rawResult(current, inputBytes, limits, state, {
    ...(error === undefined ? {} : { error }),
    ...(declared === undefined ? {} : { declared }),
  });
}

/** Never throws, even when the pipeline itself fails. */
export function decodePayload(input: PayloadInput): DecodedPayload {
  try {
    return run(input);
  } catch {
    try {
      const body =
        (input.body as unknown) instanceof Uint8Array
          ? input.body
          : new Uint8Array(0);
      const limits = tightenLimits(undefined);
      const state: State = { notes: [], truncations: [], layers: [] };
      return rawResult(
        body.subarray(0, limits.previewBytes),
        body.length,
        limits,
        state,
        {
          error: errorOf('INTERNAL', undefined),
        },
      );
    } catch {
      return {
        codec: 'raw',
        detected: {
          type: 'binary',
          mime: 'application/octet-stream',
          confidence: 0,
          source: 'fallback',
        },
        layers: [],
        view: { kind: 'hex', text: '', shownBytes: 0, totalBytes: 0 },
        error: errorOf('INTERNAL', undefined),
        notes: [],
        truncations: [],
        counters: { inputBytes: 0, decodedBytes: 0, viewBytes: 0 },
      };
    }
  }
}

/** The bytes a codec produces for a value: the reversible half of `CodecPlugin`. */
export function encodePayload(codec: CodecId, value: unknown): Uint8Array {
  const format = formatCodec(codec as FormatCodecId);
  if (format?.encode !== undefined) return format.encode(value);
  const transform = transformCodec(codec as TransformCodecId);
  if (transform?.encode !== undefined && value instanceof Uint8Array) {
    return transform.encode(value);
  }
  return fail('UNSUPPORTED_ENCODING');
}
