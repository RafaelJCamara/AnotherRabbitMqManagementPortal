import { describe, expect, it } from 'vitest';

import { decodePayload } from '../payload/decode-payload.ts';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

const base = {
  specversion: '1.0',
  id: 'A234-1234-1234',
  source: '/mycontext',
  type: 'com.example.someevent',
  time: '2018-04-05T17:31:00Z',
};

describe('CloudEvents codec', () => {
  it('M1-10 AC-14 separates the context attributes from the data (JSON data)', () => {
    const body = enc(
      JSON.stringify({
        ...base,
        datacontenttype: 'application/json',
        data: { appinfoA: 'abc', appinfoB: 123 },
      }),
    );
    const result = decodePayload({
      body,
      contentType: 'application/cloudevents+json; charset=utf-8',
    });
    expect(result.codec).toBe('cloudevents');
    expect(result.view).toMatchObject({
      kind: 'tree',
      value: {
        $cloudevent: { ...base, datacontenttype: 'application/json' },
        data: { appinfoA: 'abc', appinfoB: 123 },
      },
    });
    expect(result.detected).toMatchObject({
      type: 'cloudevents',
      source: 'header',
    });
  });

  it('M1-10 AC-14 decodes data_base64 as JSON, as text, or keeps the bytes', () => {
    const make = (type: string | undefined, raw: Uint8Array) =>
      decodePayload({
        body: enc(
          JSON.stringify({
            ...base,
            ...(type === undefined ? {} : { datacontenttype: type }),
            data_base64: Buffer.from(raw).toString('base64'),
          }),
        ),
      });
    const json = make('application/json', enc('{"a":1}'));
    expect(json.view).toMatchObject({
      kind: 'tree',
      value: { data: { a: 1 } },
    });
    // Sniffed: no content type, the specversion attribute is the signal.
    expect(json.detected).toMatchObject({
      type: 'cloudevents',
      source: 'sniff',
    });
    expect(make('text/plain', enc('hello')).view).toMatchObject({
      value: { data: 'hello' },
    });
    expect(make(undefined, Uint8Array.of(0xff, 0xfe, 0x00)).view).toMatchObject(
      {
        value: { data: { $bytes: '//4A' } },
      },
    );
    // Declared JSON, but the bytes are not: they stay bytes (no silent change).
    expect(make('application/json', enc('{nope')).view).toMatchObject({
      value: { data: { $bytes: Buffer.from('{nope').toString('base64') } },
    });
  });

  it('M1-10 AC-14 falls back to the plain JSON view with a coded note for an invalid envelope', () => {
    const invalid = [
      { specversion: '1.0', id: 'x', source: '/s' }, // no type
      { ...base, id: '' },
      { ...base, specversion: '0.3' },
      { ...base, source: 5 },
      [base],
      'text',
    ];
    for (const document of invalid) {
      const result = decodePayload({
        body: enc(JSON.stringify(document)),
        contentType: 'application/cloudevents+json',
      });
      expect(result.error, JSON.stringify(document)).toBeUndefined();
      expect(result.notes).toContainEqual({ code: 'MALFORMED_CLOUDEVENT' });
      expect(result.view.kind).toBe('tree');
    }
    // Not JSON at all: hex and the JSON error.
    const broken = decodePayload({
      body: enc('{"specversion":"1.0",'),
      contentType: 'application/cloudevents+json',
    });
    expect(broken.error?.code).toBe('MALFORMED_JSON');
    expect(broken.view.kind).toBe('hex');
  });

  it('M1-10 AC-14 an ordinary JSON document is not mistaken for an event', () => {
    const result = decodePayload({
      body: enc('{"a":1,"specversion_note":true}'),
    });
    expect(result.codec).toBe('json');
  });
});
