// Redaction for data that is stored for good (audit rows, receipts), not only logged (I-10).
//
// `redactText` is built from regular expressions that are linear on ordinary text but can take
// quadratic time on one long unbroken run of letters (a scheme-like prefix that never meets "://"),
// so a hostile string would stall the event loop (I-5). Stored data therefore never goes through them
// whole: a string longer than `MAX_SCRUB_STRING` is replaced by a marker that says how long it was,
// which also keeps a secret that straddles the cut from surviving as a prefix. Strings that stay are
// redacted first and clipped after, so a clip never leaves half a secret behind.
import { redactText, redactValue } from './redact.ts';

/** The longest string that is scrubbed; a longer one is replaced, never stored in part. */
export const MAX_SCRUB_STRING = 2048;
const MAX_KEY = 128;
const MAX_DEPTH = 12;

export function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...[clipped]`;
}

const tooLong = (length: number): string =>
  `[too long: ${String(length)} characters]`;

/** A short, redacted copy of `text`: at most `max` characters, or a marker when it is huge. */
export function scrubText(text: string, max: number): string {
  if (text.length > MAX_SCRUB_STRING) return tooLong(text.length);
  return clipText(redactText(text), max);
}

function bound(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_SCRUB_STRING ? tooLong(value.length) : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[too deep]';
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => bound(item, depth + 1));
  }
  // No prototype: a "__proto__" key becomes an own property, not a change of the copy's prototype.
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value)) {
    out[clipText(key, MAX_KEY)] = bound(entry, depth + 1);
  }
  return out;
}

/**
 * A copy of a JSON value that is safe to store: sensitive keys lose their value, every string is
 * scrubbed, and a string longer than `MAX_SCRUB_STRING` is replaced by a marker. Strings that
 * remain are clipped to `max` characters after redaction.
 */
export function scrubJson(value: unknown, max = MAX_SCRUB_STRING): unknown {
  const redacted = redactValue(bound(value, 0));
  const clip = (node: unknown, depth: number): unknown => {
    if (typeof node === 'string') return clipText(node, max);
    if (node === null || typeof node !== 'object' || depth >= MAX_DEPTH) {
      return node;
    }
    if (Array.isArray(node)) {
      return (node as unknown[]).map((item) => clip(item, depth + 1));
    }
    const out = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(node)) {
      out[key] = clip(entry, depth + 1);
    }
    return out;
  };
  return clip(redacted, 0);
}
