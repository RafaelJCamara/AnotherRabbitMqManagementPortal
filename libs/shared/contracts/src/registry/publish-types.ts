// Shared schemas of the publish contracts (M1-19): the message properties, the typed header table,
// the body and the outcome of each copy. Every collection has a maximum (I-6, I-7); no schema here
// is open (`z.any()`, `passthrough`). The specs of this API describe no recursive schema, so the
// header table is unrolled to its fixed depth.
import { z } from 'zod';

/** The bounds of one publish (R6). A bulk publish (PUB-04) will need others. */
export const PUBLISH_LIMITS = {
  copiesMax: 100,
  bodyBytesMax: 1_048_576,
  headersMax: 64,
  headerDepthMax: 8,
  textMax: 255,
  timeoutMsMin: 100,
  timeoutMsMax: 30_000,
  timeoutMsDefault: 5_000,
  reasonMax: 120,
} as const;

/**
 * The properties of a message, with the longest text a property may hold. A publisher's input is held
 * to `textMax`; what the history echoes back is held to a wider bound, because replacing a secret
 * can make a value longer than it was (see `PUBLISH_HISTORY_LIMITS.valueMax`).
 */
const propsShape = (text: z.ZodString) => ({
  contentType: text.optional(),
  contentEncoding: text.optional(),
  deliveryMode: z.union([z.literal(1), z.literal(2)]).optional(),
  priority: z.number().int().min(0).max(255).optional(),
  correlationId: text.optional(),
  replyTo: text.optional(),
  expiration: text.optional(),
  messageId: text.optional(),
  timestamp: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  type: text.optional(),
  userId: text.optional(),
  appId: text.optional(),
});

/**
 * The properties a publisher may set. Nothing else is accepted: the flags that change routing or
 * delivery (`mandatory`, `CC`, `BCC`, `immediate`) are not properties of a message here.
 */
export const PublishPropsSchema = z.strictObject(
  propsShape(z.string().max(PUBLISH_LIMITS.textMax)),
);
export type PublishProps = z.infer<typeof PublishPropsSchema>;

// --- The typed header table -----------------------------------------------------------------------
// A header keeps its AMQP type: `{ t: 'long', v: 5 }`. `bytes` travels as base64 text.

const INTEGER_TYPES = ['byte', 'short', 'int', 'long'] as const;
const FLOAT_TYPES = ['float', 'double'] as const;

/** The longest string and the longest base64 text a header value may hold. */
interface HeaderLimits {
  readonly string: number;
  readonly bytes: number;
}

const scalarVariants = (limits: HeaderLimits) =>
  [
    z.strictObject({
      t: z.literal('string'),
      v: z.string().max(limits.string),
    }),
    z.strictObject({
      t: z.enum(INTEGER_TYPES),
      v: z
        .number()
        .int()
        .min(Number.MIN_SAFE_INTEGER)
        .max(Number.MAX_SAFE_INTEGER),
    }),
    z.strictObject({ t: z.enum(FLOAT_TYPES), v: z.number() }),
    z.strictObject({ t: z.literal('bool'), v: z.boolean() }),
    z.strictObject({
      t: z.literal('timestamp'),
      v: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    }),
    z.strictObject({
      t: z.literal('decimal'),
      v: z.strictObject({
        places: z.number().int().min(0).max(255),
        digits: z.number().int().min(0).max(4_294_967_295),
      }),
    }),
    z.strictObject({ t: z.literal('bytes'), v: z.string().max(limits.bytes) }),
    z.strictObject({ t: z.literal('void'), v: z.null() }),
  ] as const;

const headerName = z.string().min(1).max(PUBLISH_LIMITS.textMax);

/**
 * One level of nesting over `inner`: a list or a table whose entries hold `inner`. Both are one
 * variant with a list of entries (a table's entries have a `name`, a list's do not), so `inner`
 * appears once per level and the emitted documents grow with the depth, not with its power of two.
 */
const nested = <T extends z.ZodType>(
  scalars: ReturnType<typeof scalarVariants>,
  inner: T,
) =>
  z.discriminatedUnion('t', [
    ...scalars,
    z
      .strictObject({
        t: z.enum(['array', 'table']),
        v: z
          .array(z.strictObject({ name: headerName.optional(), value: inner }))
          .max(PUBLISH_LIMITS.headersMax),
      })
      .refine(
        (container) => {
          const names = container.v.map((entry) => entry.name);
          return container.t === 'array'
            ? names.every((name) => name === undefined)
            : names.every((name) => name !== undefined) &&
                new Set(names).size === names.length;
        },
        { message: 'A table needs a unique name per entry; a list has none.' },
      ),
  ]);

/** A header value: scalars, or lists and tables nested at most `headerDepthMax` (8) levels. */
const headerValue = (limits: HeaderLimits) => {
  const scalars = scalarVariants(limits);
  const level0 = z.discriminatedUnion('t', scalars);
  const level1 = nested(scalars, level0);
  const level2 = nested(scalars, level1);
  const level3 = nested(scalars, level2);
  const level4 = nested(scalars, level3);
  const level5 = nested(scalars, level4);
  const level6 = nested(scalars, level5);
  const level7 = nested(scalars, level6);
  return nested(scalars, level7);
};

const headerTable = <V extends z.ZodType>(value: V) =>
  z
    .record(headerName, value)
    .refine((table) => Object.keys(table).length <= PUBLISH_LIMITS.headersMax, {
      message: 'At most 64 headers.',
    });

export const PublishHeaderValueSchema = headerValue({
  string: 65_535,
  bytes: 87_380,
});
export const PublishHeadersSchema = headerTable(PublishHeaderValueSchema);
export type PublishHeaders = z.infer<typeof PublishHeadersSchema>;

// --- The body -------------------------------------------------------------------------------------

/** The longest `data` that can still decode to the body limit (base64 is the longer encoding). */
const BODY_DATA_CHARS_MAX = Math.ceil(PUBLISH_LIMITS.bodyBytesMax / 3) * 4;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** How many bytes `data` decodes to, or `undefined` when it is not valid for its encoding. */
export function publishBodyBytes(body: {
  encoding: 'utf8' | 'base64';
  data: string;
}): number | undefined {
  if (body.encoding === 'utf8')
    return new TextEncoder().encode(body.data).length;
  if (!BASE64.test(body.data)) return undefined;
  const padding = body.data.endsWith('==')
    ? 2
    : body.data.endsWith('=')
      ? 1
      : 0;
  return (body.data.length / 4) * 3 - padding;
}

export const PublishBodySchema = z
  .strictObject({
    encoding: z.enum(['utf8', 'base64']),
    data: z.string().max(BODY_DATA_CHARS_MAX),
  })
  .superRefine((body, ctx) => {
    const bytes = publishBodyBytes(body);
    if (bytes === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'The body is not valid base64.',
      });
    } else if (bytes > PUBLISH_LIMITS.bodyBytesMax) {
      ctx.addIssue({ code: 'custom', message: 'The body is over 1 MiB.' });
    }
  });

// --- The outcome of each copy ---------------------------------------------------------------------

export const COPY_OUTCOMES = [
  'confirmed',
  'nacked',
  'returned',
  'blocked',
  'timeout',
  'failed',
  'not-sent',
] as const;
export const CopyOutcomeSchema = z.enum(COPY_OUTCOMES);
export type CopyOutcome = z.infer<typeof CopyOutcomeSchema>;

const count = z.number().int().nonnegative().max(PUBLISH_LIMITS.copiesMax);

/** One count per outcome; they add up to the number of copies. */
export const PublishSummarySchema = z.strictObject({
  confirmed: count,
  nacked: count,
  returned: count,
  blocked: count,
  timeout: count,
  failed: count,
  'not-sent': count,
});
export type PublishSummary = z.infer<typeof PublishSummarySchema>;

// --- The publish history (PUB-02) ------------------------------------------------------------------

/** The bounds of the history reads (H4, H5). */
export const PUBLISH_HISTORY_LIMITS = {
  windowMax: 200,
  idMax: 64,
  cursorMax: 128,
  /**
   * The longest value the history gives back. It is held far above the publish limits on purpose:
   * the mask replaces a secret with a longer marker, so a value can come back longer than it went in,
   * and an answer that broke its contract would hide the entry. The stored document is itself held to
   * 1 MiB, which bounds every value in it.
   */
  valueMax: 1_048_576,
} as const;

const ECHO_LIMITS = {
  string: PUBLISH_HISTORY_LIMITS.valueMax,
  bytes: PUBLISH_HISTORY_LIMITS.valueMax,
} as const;

/** One entry of a window: the plain facts, never a property, a header or the body. */
export const HistorySummarySchema = z.strictObject({
  id: z.string().min(1).max(PUBLISH_HISTORY_LIMITS.idMax),
  /** When the publish ended (epoch ms). */
  at: z.number().int().nonnegative(),
  /** When the entry stops being returned (epoch ms); 30 days after `at`. */
  expiresAt: z.number().int().nonnegative(),
  vhost: z.string().max(PUBLISH_LIMITS.textMax),
  exchange: z.string().max(PUBLISH_LIMITS.textMax),
  routingKey: z.string().max(PUBLISH_LIMITS.textMax),
  copies: z.number().int().min(1).max(PUBLISH_LIMITS.copiesMax),
  summary: PublishSummarySchema,
  /** The size of the body as published, whether or not the history kept it. */
  bodyBytes: z.number().int().nonnegative().max(PUBLISH_LIMITS.bodyBytesMax),
  /** sha256 of the body as published (hex). */
  bodySha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type HistorySummary = z.infer<typeof HistorySummarySchema>;

/**
 * What the publish studio is prefilled with to send a publish again: the fields of a publish that
 * describe the message, with every value the mask recognised as a secret replaced. The person types
 * those again; the history never held them. A secret with no recognisable shape can still be here
 * (OQ-1442), so a re-send is a starting point, not a copy.
 */
export const ResendDataSchema = z.strictObject({
  exchange: z.string().max(PUBLISH_LIMITS.textMax),
  routingKey: z.string().max(PUBLISH_LIMITS.textMax),
  props: z.strictObject(
    propsShape(z.string().max(PUBLISH_HISTORY_LIMITS.valueMax)),
  ),
  headers: headerTable(headerValue(ECHO_LIMITS)).optional(),
  /** Absent when `bodyOmitted` says why. Text only: a binary body is not kept. */
  body: z
    .strictObject({
      encoding: z.literal('utf8'),
      data: z.string().max(PUBLISH_HISTORY_LIMITS.valueMax),
    })
    .optional(),
  copies: z.number().int().min(1).max(PUBLISH_LIMITS.copiesMax),
  /** Where a value was replaced: `prop:<name>`, `header:<name>`, `body`. */
  masked: z
    .array(z.string().max(PUBLISH_LIMITS.textMax + 16))
    .max(PUBLISH_LIMITS.headersMax + 64),
  /** Why there is no body: it was binary, or over 64 KiB. Its size and sha256 stay in the summary. */
  bodyOmitted: z.enum(['too-large', 'binary']).optional(),
});
export type ResendData = z.infer<typeof ResendDataSchema>;
