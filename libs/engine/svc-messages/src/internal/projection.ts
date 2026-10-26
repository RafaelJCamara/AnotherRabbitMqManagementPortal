// The redacted projection of a message (M1-09): the only text that reaches the full-text index and
// the preview. It is built from the kernel's redaction (the engine has one policy, I-10) plus the
// exact secret values the caller names, and it errs towards leaving a word out.
//
// What goes in:
//   metadata  exchange, routing key, source, content type, a few properties (message id,
//             correlation id, type, app id), header names; outside `prod` also the header values
//             that are scalars and not credentials;
//   body      only outside `prod`, only when the capture indexes bodies, only when the body is valid
//             UTF-8 text of at most 64 KiB without a NUL. JSON bodies are walked (keys that name a
//             secret lose their value); other text goes through `redactText`.
// The kernel's expressions are linear except on one very long unbroken run of letters, so a run
// longer than `MAX_RUN` is replaced by a marker before they see the text (I-5). The result is cut
// at `MAX_BODY_TEXT` characters after redaction, never before.
import type { EnvClass } from '@app/contracts';
import {
  encodedForms,
  isSensitiveKey,
  REDACTED,
  redactText,
} from '@app/kernel';

import type { JsonValue } from './types';

/** The most characters of body text kept (the index and the preview read this). */
export const MAX_BODY_TEXT = 8192;
/** The most characters of metadata text kept. */
export const MAX_META_TEXT = 4096;
/** A body larger than this is not turned into text. */
export const MAX_TEXT_BODY_BYTES = 64 * 1024;
const MAX_RUN = 1024;
const MAX_JSON_DEPTH = 12;
const MAX_JSON_LEAVES = 2000;
const MAX_HEADERS = 64;
const MAX_VALUE_CHARS = 256;
const MIN_FORM_CHARS = 6;
const MAX_SECRETS = 32;
const MIN_SECRET_CHARS = 4;

/** Properties whose values are words a person searches for. Matched without case or separators. */
const SEARCHABLE_PROPERTIES = new Set([
  'messageid',
  'correlationid',
  'type',
  'appid',
  'contenttype',
  'contentencoding',
]);

export interface ProjectionInput {
  readonly envClass: EnvClass;
  /** The capture's switch; false keeps bodies out of the index. */
  readonly indexBodies: boolean;
  readonly exchange: string;
  readonly routingKey: string;
  readonly source: string;
  readonly contentType: string | null;
  readonly properties: Readonly<Record<string, JsonValue>>;
  readonly headers: Readonly<Record<string, JsonValue>>;
  readonly body: Uint8Array;
}

export interface Projection {
  readonly metaText: string;
  /** Null when the body is not indexed. */
  readonly bodyText: string | null;
}

const normalise = (name: string): string =>
  name.toLowerCase().replace(/[-_.\s]/g, '');

// Free text the kernel's expressions do not cover: `password=hunter2`, `"token": "abc"`, a Basic or
// Digest authorization value. Both are linear: a name, a separator, then a bounded value.
const NAMED_SECRET =
  /\b(password|passwd|passphrase|pwd|secret|client_secret|token|access_token|refresh_token|api[_-]?key|apikey|authorization|auth|cookie|set-cookie)(["']?\s*[:=]\s*["']?)[^\s"',;&}]{1,512}/gi;
const AUTH_SCHEME = /\b(Basic|Digest|Negotiate)\s+[A-Za-z0-9+/=._~-]{8,}/g;

/**
 * The two rules the kernel's redaction lacks: `name=value` and `"name": "value"` for names that say
 * a secret, and Basic, Digest and Negotiate authorization values. Linear: a name, a separator, then a
 * bounded value. The publish history (M1-19) applies them too, so the engine keeps one policy.
 */
export function redactNamedCredentials(text: string): string {
  return text
    .replace(AUTH_SCHEME, `$1 ${REDACTED}`)
    .replace(NAMED_SECRET, `$1$2${REDACTED}`);
}

/** Every encoded form of every secret that is long enough to be told from ordinary text. */
export function secretPatterns(secrets: readonly string[]): readonly RegExp[] {
  const patterns: RegExp[] = [];
  for (const secret of secrets.slice(0, MAX_SECRETS)) {
    if (secret.length < MIN_SECRET_CHARS) continue;
    const seen = new Set<string>();
    for (const form of encodedForms(secret)) {
      if (form.text.length < MIN_FORM_CHARS || seen.has(form.text)) continue;
      seen.add(form.text);
      patterns.push(
        new RegExp(
          form.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          form.fold ? 'gi' : 'g',
        ),
      );
    }
    // The raw value may be short (4 to 5 characters): it is still removed as a whole.
    if (secret.length < MIN_FORM_CHARS) {
      patterns.push(
        new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
      );
    }
  }
  return patterns;
}

/** Replaces long unbroken runs, then applies the kernel's rules and the exact secrets. */
export function redactProjectionText(
  text: string,
  secrets: readonly RegExp[],
): string {
  const bounded = text.replace(
    new RegExp(`\\S{${String(MAX_RUN + 1)},}`, 'g'),
    '[long]',
  );
  let out = redactNamedCredentials(redactText(bounded));
  for (const pattern of secrets) out = out.replace(pattern, REDACTED);
  return out;
}

function scalar(value: JsonValue): string | undefined {
  if (typeof value === 'string') return value.slice(0, MAX_VALUE_CHARS);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

function metaWords(
  input: ProjectionInput,
  clear: boolean,
  secrets: readonly RegExp[],
): string {
  const words: string[] = [
    input.exchange,
    input.routingKey,
    input.source,
    input.contentType ?? '',
  ];
  for (const [name, value] of Object.entries(input.properties)) {
    if (!SEARCHABLE_PROPERTIES.has(normalise(name))) continue;
    const text = scalar(value);
    if (text !== undefined && !isSensitiveKey(name)) words.push(text);
  }
  for (const [name, value] of Object.entries(input.headers).slice(
    0,
    MAX_HEADERS,
  )) {
    words.push(name.slice(0, MAX_VALUE_CHARS));
    if (!clear || isSensitiveKey(name)) continue;
    const text = scalar(value);
    if (text !== undefined) words.push(text);
  }
  const joined = words.filter((w) => w !== '').join(' ');
  return redactProjectionText(joined, secrets).slice(0, MAX_META_TEXT);
}

/** The text of a JSON value: keys and scalar leaves, a secret's value replaced. */
function jsonText(root: unknown, secrets: readonly RegExp[]): string {
  const parts: string[] = [];
  let leaves = 0;
  const walk = (value: unknown, depth: number): void => {
    if (leaves >= MAX_JSON_LEAVES || depth > MAX_JSON_DEPTH) return;
    if (Array.isArray(value)) {
      for (const item of value as unknown[]) walk(item, depth + 1);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        if (leaves >= MAX_JSON_LEAVES) return;
        parts.push(
          redactProjectionText(key.slice(0, MAX_VALUE_CHARS), secrets),
        );
        if (isSensitiveKey(key)) {
          parts.push(REDACTED);
          leaves += 1;
        } else {
          walk(entry, depth + 1);
        }
      }
      return;
    }
    if (typeof value === 'string') {
      leaves += 1;
      parts.push(redactProjectionText(value, secrets));
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      leaves += 1;
      parts.push(String(value));
    }
  };
  walk(root, 0);
  return parts.join(' ');
}

function bodyWords(
  body: Uint8Array,
  contentType: string | null,
  secrets: readonly RegExp[],
): string | null {
  if (body.byteLength === 0 || body.byteLength > MAX_TEXT_BODY_BYTES) {
    return null;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return null;
  }
  if (text.includes('\u0000')) return null;
  const jsonLike =
    (contentType?.toLowerCase().includes('json') ?? false) ||
    /^\s*[{[]/.test(text);
  if (jsonLike) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object') {
        return jsonText(parsed, secrets).slice(0, MAX_BODY_TEXT);
      }
    } catch {
      // Not JSON after all: the text rules below apply.
    }
  }
  return redactProjectionText(text, secrets).slice(0, MAX_BODY_TEXT);
}

export function buildProjection(
  input: ProjectionInput,
  secretValues: readonly string[] = [],
): Projection {
  const secrets = secretPatterns(secretValues);
  const prod = input.envClass === 'prod';
  const metaText = metaWords(input, !prod, secrets);
  const bodyText =
    prod || !input.indexBodies
      ? null
      : bodyWords(input.body, input.contentType, secrets);
  return { metaText, bodyText };
}
