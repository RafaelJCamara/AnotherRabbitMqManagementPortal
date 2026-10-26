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

const text = z.string().max(PUBLISH_LIMITS.textMax);

/**
 * The properties a publisher may set. Nothing else is accepted: the flags that change routing or
 * delivery (`mandatory`, `CC`, `BCC`, `immediate`) are not properties of a message here.
 */
export const PublishPropsSchema = z.strictObject({
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
export type PublishProps = z.infer<typeof PublishPropsSchema>;

// --- The typed header table -----------------------------------------------------------------------
// A header keeps its AMQP type: `{ t: 'long', v: 5 }`. `bytes` travels as base64 text.

const INTEGER_TYPES = ['byte', 'short', 'int', 'long'] as const;
const FLOAT_TYPES = ['float', 'double'] as const;

const scalarVariants = [
  z.strictObject({ t: z.literal('string'), v: z.string().max(65_535) }),
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
  z.strictObject({ t: z.literal('bytes'), v: z.string().max(87_380) }),
  z.strictObject({ t: z.literal('void'), v: z.null() }),
] as const;

const headerName = z.string().min(1).max(PUBLISH_LIMITS.textMax);

/**
 * One level of nesting over `inner`: a list or a table whose entries hold `inner`. Both are one
 * variant with a list of entries (a table's entries have a `name`, a list's do not), so `inner`
 * appears once per level and the emitted documents grow with the depth, not with its power of two.
 */
const nested = <T extends z.ZodType>(inner: T) =>
  z.discriminatedUnion('t', [
    ...scalarVariants,
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

const level0 = z.discriminatedUnion('t', scalarVariants);
const level1 = nested(level0);
const level2 = nested(level1);
const level3 = nested(level2);
const level4 = nested(level3);
const level5 = nested(level4);
const level6 = nested(level5);
const level7 = nested(level6);
/** A header value: scalars, or lists and tables nested at most `headerDepthMax` (8) levels. */
export const PublishHeaderValueSchema = nested(level7);

export const PublishHeadersSchema = z
  .record(headerName, PublishHeaderValueSchema)
  .refine((table) => Object.keys(table).length <= PUBLISH_LIMITS.headersMax, {
    message: 'At most 64 headers.',
  });
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
