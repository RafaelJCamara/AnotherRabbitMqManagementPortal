// Masking a publish for its history (M1-19, H3). What a person publishes may carry credentials: an
// Authorization header, a password in a JSON body, a URL with user:pass@. The history keeps the
// message so it can be sent again, but never the secret the mask recognises: the values are replaced
// before anything is sealed (so a stolen database holds none of them) and again on read.
//
//   header or property whose name says a secret   -> the whole value becomes REDACTED
//   any string value                              -> the kernel's text rules (credentialed URIs,
//                                                    secret query parameters, JWTs, Bearer values)
//                                                    plus `name=value` and Basic/Digest values
//   a JSON body                                   -> walked: keys that name a secret lose their value
//   a body that is not UTF-8 text, or over 64 KiB -> not kept (its size and sha256 are)
//
// The kernel's expressions are linear except on a long unbroken run of letters (3.5 s for 64 KiB, a
// stall of the event loop, I-5). A run of more than `MASK_MAX_RUN` characters without whitespace is
// therefore replaced by a marker before the expressions see it; a value with one is shown as masked.
// The projection of the capture store does the same, but it also shortens the text it indexes; this
// file keeps every other character so a masked body can still be sent again.
//
// The mask can miss a secret with no recognisable shape (a bare token in free text). That is a stated
// limit, not a guarantee (OQ-1442). Nothing here logs, and no error names a value (I-10).
import { isSensitiveKey, REDACTED, redactText, redactValue } from '@app/kernel';

import { redactNamedCredentials } from './projection';

/** A body larger than this is not kept in the history. */
export const MASK_MAX_BODY_BYTES = 64 * 1024;
/** The longest run of non-space characters the expressions see; a longer one becomes the marker. */
export const MASK_MAX_RUN = 1024;
/** What stands in for a run longer than `MASK_MAX_RUN`. */
export const LONG_RUN_MARKER = '[long]';

/** Past this nesting a JSON value or a header container is dropped rather than inspected. */
const MAX_DEPTH = 32;

export type BodyOmitted = 'too-large' | 'binary';

/** A header value as the contract carries it: a type name and a value. */
export interface WireHeader {
  readonly t: string;
  readonly v: unknown;
}

export interface MaskedBodyText {
  readonly encoding: 'utf8';
  readonly data: string;
}

/** A message with every secret the mask recognises replaced. */
export interface MaskedMessage {
  readonly props: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, WireHeader>>;
  readonly body?: MaskedBodyText;
  /** Why there is no body, when there is none. */
  readonly bodyOmitted?: BodyOmitted;
  /** Where a value was replaced: `prop:<name>`, `header:<name>`, `body`. */
  readonly masked: readonly string[];
}

const LONG_RUN = new RegExp(`\\S{${String(MASK_MAX_RUN + 1)},}`, 'g');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Applies every text rule to one string. */
export function maskString(text: string): string {
  return redactNamedCredentials(
    redactText(text.replace(LONG_RUN, LONG_RUN_MARKER)),
  );
}

// --- Properties ---------------------------------------------------------------------------------

function maskProps(props: Readonly<Record<string, unknown>>): {
  props: Record<string, unknown>;
  masked: string[];
} {
  const out: Record<string, unknown> = {};
  const masked: string[] = [];
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined) continue;
    let next = value;
    if (isSensitiveKey(name)) next = REDACTED;
    else if (typeof value === 'string') next = maskString(value);
    if (next !== value) masked.push(`prop:${name}`);
    out[name] = next;
  }
  return { props: out, masked };
}

// --- Headers ------------------------------------------------------------------------------------

const REDACTED_VALUE: WireHeader = { t: 'string', v: REDACTED };

const isRedactedValue = (header: WireHeader): boolean =>
  header.t === 'string' && header.v === REDACTED;

function decodeText(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return undefined;
  }
}

interface Masked<T> {
  readonly value: T;
  readonly changed: boolean;
}

function maskHeaderValue(header: unknown, depth: number): Masked<WireHeader> {
  // A value that is not shaped like a header (a damaged document) is not shown at all.
  if (!isRecord(header) || typeof header.t !== 'string') {
    return { value: REDACTED_VALUE, changed: true };
  }
  const { t, v } = header as unknown as WireHeader;
  if (t === 'string' && typeof v === 'string') {
    const text = maskString(v);
    return { value: { t, v: text }, changed: text !== v };
  }
  if (t === 'bytes' && typeof v === 'string') {
    // Bytes that read as text are held to the text rules; one with a secret in it is not shown.
    const text = decodeText(new Uint8Array(Buffer.from(v, 'base64')));
    return text !== undefined && maskString(text) !== text
      ? { value: REDACTED_VALUE, changed: true }
      : { value: { t, v }, changed: false };
  }
  if (t === 'array' || t === 'table') {
    if (!Array.isArray(v) || depth >= MAX_DEPTH) {
      return { value: REDACTED_VALUE, changed: true };
    }
    let changed = false;
    const entries: unknown[] = (v as unknown[]).map((entry) => {
      if (!isRecord(entry)) {
        changed = true;
        return { value: REDACTED_VALUE };
      }
      const name = typeof entry.name === 'string' ? entry.name : undefined;
      const inner =
        name !== undefined && isSensitiveKey(name)
          ? {
              value: REDACTED_VALUE,
              changed: !isRedactedValue(entry.value as WireHeader),
            }
          : maskHeaderValue(entry.value, depth + 1);
      changed ||= inner.changed;
      return name === undefined
        ? { value: inner.value }
        : { name, value: inner.value };
    });
    return { value: { t, v: entries }, changed };
  }
  // Numbers, booleans, timestamps, decimals and void hold no text.
  return { value: { t, v }, changed: false };
}

function maskHeaders(headers: Readonly<Record<string, WireHeader>>): {
  headers: Record<string, WireHeader>;
  masked: string[];
} {
  // No prototype: a header called `__proto__` stays an own key.
  const out = Object.create(null) as Record<string, WireHeader>;
  const masked: string[] = [];
  for (const [name, header] of Object.entries(headers)) {
    const result = isSensitiveKey(name)
      ? {
          value: REDACTED_VALUE,
          changed: !(isRecord(header) && isRedactedValue(header)),
        }
      : maskHeaderValue(header, 1);
    if (result.changed) masked.push(`header:${name}`);
    out[name] = result.value;
  }
  return { headers: out, masked };
}

// --- Body ---------------------------------------------------------------------------------------

/**
 * Every string of a JSON value masked; past `MAX_DEPTH` the rest is dropped (a body can nest far
 * deeper than the stack allows, and it is never walked or written back in full). `seen.changed`
 * turns true when a string was masked or a branch was cut.
 */
function maskJsonStrings(
  value: unknown,
  depth: number,
  seen: { changed: boolean },
): unknown {
  if (typeof value === 'string') {
    const masked = maskString(value);
    if (masked !== value) seen.changed = true;
    return masked;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) {
    seen.changed = true;
    return REDACTED;
  }
  if (Array.isArray(value)) {
    return value.map((entry: unknown) =>
      maskJsonStrings(entry, depth + 1, seen),
    );
  }
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value)) {
    out[key] = maskJsonStrings(entry, depth + 1, seen);
  }
  return out;
}

/** Text that is a JSON document is walked; any other text goes through the text rules. */
export function maskBodyText(text: string): Masked<string> {
  const first = text.trimStart().charAt(0);
  if (first === '{' || first === '[' || first === '"') {
    let parsed: unknown;
    let ok = true;
    try {
      parsed = JSON.parse(text);
    } catch {
      ok = false;
    }
    if (ok) {
      const seen = { changed: false };
      const walked = maskJsonStrings(parsed, 0, seen);
      const after = JSON.stringify(redactValue(walked));
      // Unchanged: keep the original text, with its layout and its numbers as typed. Both sides
      // are at most `MAX_DEPTH` deep, so neither stringify can overflow the stack.
      return !seen.changed && after === JSON.stringify(walked)
        ? { value: text, changed: false }
        : { value: after, changed: true };
    }
  }
  const masked = maskString(text);
  return { value: masked, changed: masked !== text };
}

export type MaskedBody =
  | (Masked<string> & { readonly kind: 'text' })
  | { readonly kind: 'omitted'; readonly reason: BodyOmitted };

/** The body of a publish as the history keeps it: masked text, or nothing and the reason. */
export function maskBody(body: Uint8Array): MaskedBody {
  if (body.byteLength > MASK_MAX_BODY_BYTES) {
    return { kind: 'omitted', reason: 'too-large' };
  }
  const text = decodeText(body);
  if (text === undefined || text.includes('\0')) {
    return { kind: 'omitted', reason: 'binary' };
  }
  return { kind: 'text', ...maskBodyText(text) };
}

// --- The message --------------------------------------------------------------------------------

export interface MaskInput {
  readonly props: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, WireHeader>>;
  readonly body: Uint8Array;
}

/** Masks a publish before it is sealed. */
export function maskMessage(input: MaskInput): MaskedMessage {
  const props = maskProps(input.props);
  const headers =
    input.headers === undefined ? undefined : maskHeaders(input.headers);
  const body = maskBody(input.body);
  return {
    props: props.props,
    ...(headers === undefined ? {} : { headers: headers.headers }),
    ...(body.kind === 'text'
      ? { body: { encoding: 'utf8' as const, data: body.value } }
      : { bodyOmitted: body.reason }),
    masked: [
      ...props.masked,
      ...(headers?.masked ?? []),
      ...(body.kind === 'text' && body.changed ? ['body'] : []),
    ],
  };
}

/**
 * Masks what the history holds, on read: the same rules again, so an entry written under an older
 * rule set, or damaged on disk, cannot hand a secret back. Rules are idempotent; the places that
 * were masked on write stay in the list.
 */
export function remaskMessage(stored: MaskedMessage): MaskedMessage {
  const props = maskProps(stored.props);
  const headers =
    stored.headers === undefined ? undefined : maskHeaders(stored.headers);
  const body =
    stored.body === undefined ? undefined : maskBodyText(stored.body.data);
  const masked = [
    ...stored.masked,
    ...props.masked,
    ...(headers?.masked ?? []),
    ...(body?.changed === true ? ['body'] : []),
  ];
  return {
    props: props.props,
    ...(headers === undefined ? {} : { headers: headers.headers }),
    ...(body === undefined
      ? {}
      : { body: { encoding: 'utf8' as const, data: body.value } }),
    ...(stored.bodyOmitted === undefined
      ? {}
      : { bodyOmitted: stored.bodyOmitted }),
    masked: [...new Set(masked)],
  };
}
