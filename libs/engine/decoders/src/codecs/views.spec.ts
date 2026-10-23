import { describe, expect, it } from 'vitest';

import { decodePayload } from '../payload/decode-payload.ts';
import { decodeBase64Text } from './base64.ts';
import { decodeHexText } from './hex.ts';
import { hexDump } from './views.ts';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('hex and base64 views and text encodings of bytes', () => {
  it('M1-10 AC-6 shows a hex dump with an offset column and an ASCII gutter', () => {
    const dump = hexDump(enc('Hello, world! 0123456789'), 1000);
    expect(dump.split('\n')).toEqual([
      '00000000  48 65 6c 6c 6f 2c 20 77  6f 72 6c 64 21 20 30 31  |Hello, world! 01|',
      '00000010  32 33 34 35 36 37 38 39                           |23456789|',
    ]);
  });

  it('M1-10 AC-6 caps a hex or base64 view and counts the bytes left out', () => {
    const bytes = new Uint8Array(1000).map((_, i) => (i * 7) & 0xff);
    for (const view of ['hex', 'base64'] as const) {
      const result = decodePayload({
        body: bytes,
        view,
        limits: { previewBytes: 100 },
      });
      expect(result.codec).toBe('raw');
      expect(result.view).toMatchObject({
        kind: view,
        shownBytes: 100,
        totalBytes: 1000,
      });
      expect(result.truncations).toEqual([
        { what: 'preview', max: 100, dropped: 900 },
      ]);
    }
    const whole = decodePayload({ body: bytes, view: 'hex' });
    expect(whole.view).toMatchObject({ shownBytes: 1000 });
    expect(whole.truncations).toEqual([]);
  });

  it('M1-10 AC-6 decodes base64 text in every common spelling and runs the bytes through the codecs again', () => {
    const text = '{"hello":"world"}';
    const standard = Buffer.from(text).toString('base64');
    const spellings = [
      standard,
      standard.replace(/=+$/, ''),
      `${standard.slice(0, 8)}\r\n${standard.slice(8)}\n`,
      Buffer.from(text).toString('base64url'),
    ];
    for (const spelling of spellings) {
      const result = decodePayload({
        body: enc(spelling),
        contentEncoding: 'base64',
      });
      expect(result.layers).toEqual([
        {
          encoding: 'base64',
          source: 'header',
          inBytes: spelling.length,
          outBytes: text.length,
        },
      ]);
      expect(result.view.kind).toBe('tree');
    }
    // URL-safe characters decode to the same bytes as the standard ones.
    expect(decodeBase64Text(enc('-__-'), 100)).toEqual(
      decodeBase64Text(enc('+//+'), 100),
    );
    expect(Array.from(decodeBase64Text(enc('+//+'), 100))).toEqual([
      0xfb, 0xff, 0xfe,
    ]);
  });

  it('M1-10 AC-6 refuses bad base64 and bad hex with a coded error, never partial bytes', () => {
    for (const bad of ['a', 'ab=c', 'abcd===', '@@@@', '', '====', 'abc=d']) {
      const result = decodePayload({
        body: enc(bad),
        contentEncoding: 'base64',
      });
      if (bad === '') {
        expect(result.counters.decodedBytes).toBe(0);
        continue;
      }
      expect(result.error?.code, bad).toBe('MALFORMED_BASE64');
      expect(result.view.kind).toBe('hex');
    }
    for (const bad of ['abc', '0g', '0x12']) {
      const result = decodePayload({
        body: enc(bad),
        contentEncoding: 'hex',
      });
      expect(result.error?.code, bad).toBe('MALFORMED_HEX');
    }
    expect(() => decodeHexText(enc('aabb'), 1)).toThrow();
    expect(() => decodeBase64Text(enc('AAAAAAAA'), 3)).toThrow();
  });

  it('M1-10 AC-6 decodes hex text, with spaces and upper case, to its bytes', () => {
    const result = decodePayload({
      body: enc('7B 22 61 22 3A 31 7d'),
      contentEncoding: 'hex',
    });
    expect(result.layers[0]).toMatchObject({ encoding: 'hex', outBytes: 7 });
    expect(result.view).toMatchObject({ kind: 'tree', value: { a: 1 } });
  });

  it('M1-10 AC-6 stacks layers up to the limit and no further', () => {
    let body: Uint8Array = enc('{"a":1}');
    for (let i = 0; i < 4; i++) {
      body = enc(Buffer.from(body).toString('base64'));
    }
    const result = decodePayload({
      body,
      contentEncoding: 'base64, base64, base64, base64',
    });
    expect(result.error?.code).toBe('LAYER_LIMIT');
    expect(result.layers).toHaveLength(3);
    expect(result.view.kind).toBe('hex');
    const three = decodePayload({
      body: enc(
        Buffer.from(
          Buffer.from(Buffer.from('{"a":1}').toString('base64')).toString(
            'base64',
          ),
        ).toString('base64'),
      ),
      contentEncoding: 'base64, base64, base64',
    });
    expect(three.view.kind).toBe('tree');
  });
});
