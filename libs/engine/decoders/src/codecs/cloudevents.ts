// CloudEvents in structured content mode (a JSON body that is the whole event; OQ-967). Binary
// mode keeps the attributes in message headers, whose exact names must come from a recorded
// message, so it is not guessed here. The required attributes of spec 1.0 are checked; a JSON
// document that is not an event falls back to the plain JSON view with a coded note.
import { fail } from './errors.ts';
import { jsonCodec } from './json.ts';
import { decodeBase64Text } from './base64.ts';
import { base64Of, documentOutput, setOwn } from './tree.ts';
import type { FormatCodec, JsonValue } from './types.ts';

const REQUIRED = ['specversion', 'id', 'source', 'type'] as const;
// Versions of the CloudEvents spec this reads (a set, not a comparison: it is not a broker version).
const SPEC_VERSIONS: ReadonlySet<string> = new Set(['1.0']);
const MARKER = Buffer.from('"specversion"');

function isObject(
  value: JsonValue,
): value is Readonly<Record<string, JsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const cloudeventsCodec: FormatCodec = {
  kind: 'format',
  id: 'cloudevents',
  mimes: ['application/cloudevents+json', 'application/cloudevents'],
  detect(sample) {
    const first = jsonCodec.detect(sample);
    if (first < 0.5) return 0;
    return Buffer.from(
      sample.buffer,
      sample.byteOffset,
      sample.length,
    ).includes(MARKER)
      ? 0.9
      : 0;
  },
  decode(bytes, context) {
    const plain = jsonCodec.decode(bytes, context);
    const view = plain.view;
    const invalid = (): ReturnType<FormatCodec['decode']> => ({
      ...plain,
      notes: [...plain.notes, { code: 'MALFORMED_CLOUDEVENT' }],
    });
    if (view.kind !== 'tree') return invalid();
    const event = view.value;
    if (!isObject(event)) return invalid();
    for (const name of REQUIRED) {
      const value = event[name];
      if (typeof value !== 'string' || value === '') return invalid();
    }
    if (!SPEC_VERSIONS.has(event.specversion as string)) return invalid();

    const attributes: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(event)) {
      if (key !== 'data' && key !== 'data_base64')
        setOwn(attributes, key, value);
    }
    const out: Record<string, JsonValue> = { $cloudevent: attributes };
    const contentType = event.datacontenttype;
    const isJson = typeof contentType === 'string' && /json/i.test(contentType);
    const encoded = event.data_base64;
    if (typeof encoded === 'string') {
      let raw: Uint8Array;
      try {
        raw = decodeBase64Text(
          new TextEncoder().encode(encoded),
          context.limits.maxViewBytes,
        );
      } catch {
        return fail('MALFORMED_CLOUDEVENT');
      }
      let data: JsonValue = { $bytes: base64Of(raw) };
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
        data = isJson ? (JSON.parse(text) as JsonValue) : text;
      } catch {
        // not text, or not JSON as declared: the bytes stay as bytes
      }
      setOwn(out, 'data', data);
    } else if ('data' in event) {
      setOwn(out, 'data', event.data);
    }
    return documentOutput(
      out,
      'cloudevents',
      'application/cloudevents+json',
      context.limits,
    );
  },
};
