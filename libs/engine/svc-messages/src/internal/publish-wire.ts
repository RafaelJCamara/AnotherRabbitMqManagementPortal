// The wire side of a publish: the contract's JSON body and typed headers turned into what the lease
// takes, and what the action reports about each copy. Pure, no I/O. Nothing here logs or throws a
// value: a refusal names the rule, never the text that broke it (I-10).
import {
  ErrorCodeSchema,
  PUBLISH_LIMITS,
  type CopyOutcome,
  type ErrorCode,
} from '@app/contracts';
import type { TypedHeaderValue } from '@app/ports';

/** A header value as the contract carries it: a type name and a value, and nothing deeper is read. */
interface WireHeader {
  readonly t: string;
  readonly v: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Thrown for input the contract should have refused; the action turns it into a Problem. */
export class PublishWireError extends Error {
  constructor(rule: string) {
    super(rule);
    this.name = 'PublishWireError';
  }
}

/** The bytes of a validated body. */
export function decodeBody(body: {
  readonly encoding: 'utf8' | 'base64';
  readonly data: string;
}): Uint8Array {
  const bytes =
    body.encoding === 'utf8'
      ? new TextEncoder().encode(body.data)
      : new Uint8Array(Buffer.from(body.data, 'base64'));
  if (bytes.byteLength > PUBLISH_LIMITS.bodyBytesMax) {
    throw new PublishWireError('the body is over the limit');
  }
  return bytes;
}

const INTEGER_TYPES = new Set(['byte', 'short', 'int', 'long']);

function toTyped(wire: WireHeader, depth: number): TypedHeaderValue {
  const { t, v } = wire;
  if (t === 'string' && typeof v === 'string') return { t, v };
  if (INTEGER_TYPES.has(t) && typeof v === 'number') {
    return { t: t as 'byte' | 'short' | 'int' | 'long', v };
  }
  if ((t === 'float' || t === 'double') && typeof v === 'number') {
    return { t, v };
  }
  if (t === 'bool' && typeof v === 'boolean') return { t, v };
  if (t === 'timestamp' && typeof v === 'number') return { t, v };
  if (t === 'void') return { t, v: null };
  if (t === 'decimal' && isRecord(v)) {
    return { t, v: { places: v.places, digits: v.digits } };
  }
  if (t === 'bytes' && typeof v === 'string') {
    return { t, v: new Uint8Array(Buffer.from(v, 'base64')) };
  }
  if ((t === 'array' || t === 'table') && Array.isArray(v)) {
    const entries: unknown[] = v;
    // A container at `depth` is the depth-th list or table on its way down from the header.
    if (depth > PUBLISH_LIMITS.headerDepthMax) {
      throw new PublishWireError('the headers are nested too deep');
    }
    if (entries.length > PUBLISH_LIMITS.headersMax) {
      throw new PublishWireError('a header container has too many entries');
    }
    const items = entries.map((entry) => {
      if (!isRecord(entry) || !isRecord(entry.value)) {
        throw new PublishWireError('a header container entry is malformed');
      }
      const inner = toTyped(entry.value as unknown as WireHeader, depth + 1);
      return { name: entry.name, inner };
    });
    if (t === 'array') return { t, v: items.map((item) => item.inner) };
    // A header called `__proto__` stays an own key: the table has no prototype.
    const table = Object.create(null) as Record<string, TypedHeaderValue>;
    for (const item of items) {
      if (typeof item.name !== 'string') {
        throw new PublishWireError('a table entry has no name');
      }
      table[item.name] = item.inner;
    }
    return { t, v: table };
  }
  throw new PublishWireError('a header value does not fit its type');
}

/** The typed header table the lease takes, from the contract's. */
export function toTypedHeaders(
  headers: Readonly<Record<string, WireHeader>>,
): Record<string, TypedHeaderValue> {
  const out = Object.create(null) as Record<string, TypedHeaderValue>;
  const names = Object.keys(headers);
  if (names.length > PUBLISH_LIMITS.headersMax) {
    throw new PublishWireError('too many headers');
  }
  for (const name of names) {
    const wire = headers[name];
    if (wire !== undefined) out[name] = toTyped(wire, 1);
  }
  return out;
}

// --- What the lease said, as the action reports it -------------------------------------------------

/** A broker reply code such as `NO_ROUTE`; free text is never repeated (it could carry anything). */
const REPLY_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

export const REASONS = {
  nacked: 'the broker nacked the message',
  returned: 'returned by the broker',
  blocked: 'the connection is blocked; nothing was sent',
  timeout: 'no confirm in time; the broker may still have routed the message',
  stopped: 'not sent: an earlier copy ended the publish',
  cancelled: 'not sent: the call was cancelled or ran out of time',
} as const;

export function reasonFor(
  outcome: CopyOutcome,
  leaseReason: string | undefined,
): string | undefined {
  switch (outcome) {
    case 'nacked':
    case 'blocked':
    case 'timeout':
      return REASONS[outcome];
    case 'returned':
      return leaseReason !== undefined && REPLY_CODE.test(leaseReason)
        ? leaseReason
        : REASONS.returned;
    default:
      return undefined;
  }
}

/** The contract error code of a thrown adapter error, or `INTERNAL`. Reads `code` and nothing else. */
export function failureCode(error: unknown): ErrorCode {
  const code = isRecord(error) ? ErrorCodeSchema.safeParse(error.code) : null;
  return code?.success === true ? code.data : 'INTERNAL';
}

/** The adapter's own safe `detail`, clipped; never `message`, which could hold anything. */
export function failureDetail(error: unknown): string | undefined {
  return isRecord(error) &&
    typeof error.detail === 'string' &&
    error.detail.length > 0
    ? error.detail.slice(0, 200)
    : undefined;
}
