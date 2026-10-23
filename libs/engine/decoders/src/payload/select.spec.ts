import { describe, expect, it } from 'vitest';

import { decodePayload } from './decode-payload.ts';
import { matchRule, queueMatches } from './rules.ts';
import { parseContentType, parseEncodings } from './select.ts';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('selection of the codec and the encoding', () => {
  it('M1-10 AC-4 a rule beats the content type, and the content type beats a sniff', () => {
    const body = enc('{"a":1}');
    const byRule = decodePayload({
      body,
      queue: 'orders.new',
      contentType: 'application/json',
      rules: [{ queue: 'orders.*', codec: 'text' }],
    });
    expect(byRule.codec).toBe('text');
    expect(byRule.detected.source).toBe('rule');

    const byHeader = decodePayload({
      body,
      contentType: 'application/json',
    });
    expect(byHeader.codec).toBe('json');
    expect(byHeader.detected).toMatchObject({
      type: 'json',
      source: 'header',
      confidence: 0.95,
    });

    const bySniff = decodePayload({ body });
    expect(bySniff.codec).toBe('json');
    expect(bySniff.detected.source).toBe('sniff');
    expect(bySniff.detected.confidence).toBeGreaterThan(0.5);
    expect(bySniff.detected.confidence).toBeLessThan(0.95);
  });

  it('M1-10 AC-4 a generic type lets the bytes decide, a specific type is trusted', () => {
    const json = enc('{"a":1}');
    expect(decodePayload({ body: json, contentType: 'text/plain' }).codec).toBe(
      'json',
    );
    expect(
      decodePayload({ body: json, contentType: 'application/octet-stream' })
        .codec,
    ).toBe('json');
    // application/problem+json selects the json codec through its +json suffix.
    expect(
      decodePayload({ body: json, contentType: 'application/problem+json' })
        .detected.source,
    ).toBe('header');
    // A specific type that the bytes do not fit is shown as hex with the reason (no guessing).
    const wrong = decodePayload({
      body: enc('plain words'),
      contentType: 'application/json',
    });
    expect(wrong.codec).toBe('raw');
    expect(wrong.view.kind).toBe('hex');
    expect(wrong.error?.code).toBe('MALFORMED_JSON');
    // Plain text with no hint is text.
    expect(decodePayload({ body: enc('hello there') }).codec).toBe('text');
    // Bytes that nothing claims are hex without an error.
    const binary = decodePayload({ body: Uint8Array.of(0, 1, 2, 3, 255) });
    expect(binary.view.kind).toBe('hex');
    expect(binary.error).toBeUndefined();
    expect(binary.detected.source).toBe('fallback');
  });

  it('M1-10 AC-4 the charset comes from a BOM, the content type, a UTF-16 pattern or a rule', () => {
    const latin = decodePayload({
      body: Uint8Array.of(0x63, 0x61, 0x66, 0xe9),
      contentType: 'text/plain; charset="ISO-8859-1"',
    });
    expect(latin.view).toMatchObject({ kind: 'text', text: 'café' });

    const bom16 = decodePayload({
      body: Uint8Array.of(0xff, 0xfe, 0x68, 0x00, 0x69, 0x00),
    });
    expect(bom16.view).toMatchObject({
      kind: 'text',
      text: 'hi',
      charset: 'utf-16le',
    });

    const pattern = new Uint8Array(40);
    for (let i = 0; i < 20; i++) pattern[2 * i + 1] = 0x61 + (i % 26);
    const be = decodePayload({ body: pattern });
    expect(be.view).toMatchObject({ kind: 'text', charset: 'utf-16be' });

    const bom8 = decodePayload({
      body: Uint8Array.of(0xef, 0xbb, 0xbf, 0x68, 0x69),
    });
    expect(bom8.view).toMatchObject({ kind: 'text', text: 'hi' });

    const byRule = decodePayload({
      body: Uint8Array.of(0xe9),
      queue: 'legacy',
      rules: [{ queue: 'legacy', charset: 'windows-1252' }],
    });
    expect(byRule.view).toMatchObject({ kind: 'text', text: 'é' });
  });

  it('M1-10 AC-4 an unknown charset or encoding falls back to hex with an error', () => {
    const charset = decodePayload({
      body: enc('hello'),
      contentType: 'text/plain; charset=x-no-such-charset',
    });
    expect(charset.view.kind).toBe('hex');
    expect(charset.error?.code).toBe('UNSUPPORTED_CHARSET');

    const encoding = decodePayload({
      body: Uint8Array.of(1, 2, 3, 4),
      contentEncoding: 'snappy',
    });
    expect(encoding.view.kind).toBe('hex');
    expect(encoding.error?.code).toBe('UNSUPPORTED_ENCODING');
    expect(encoding.notes).toContainEqual({ code: 'UNSUPPORTED_ENCODING' });

    // A charset in content-encoding is a hint that many clients send; it is not an error.
    const hint = decodePayload({
      body: Uint8Array.of(0xe9),
      contentEncoding: 'latin1',
      contentType: 'text/plain',
    });
    expect(hint.view).toMatchObject({ kind: 'text', text: 'é' });
    expect(hint.error).toBeUndefined();
  });

  it('M1-10 AC-4 header parsing is bounded and lenient', () => {
    expect(parseContentType('Application/JSON ; Charset=UTF-8')).toEqual({
      mime: 'application/json',
      charset: 'utf-8',
    });
    expect(parseContentType(42)).toEqual({});
    expect(parseContentType('nonsense')).toEqual({});
    expect(parseContentType(`text/plain;${' '.repeat(5000)}charset=x`)).toEqual(
      {
        mime: 'text/plain',
      },
    );
    const many = parseEncodings('identity, , base64,'.repeat(10));
    expect(many.transforms.length).toBeLessThanOrEqual(8);
    expect(parseEncodings('hex, base64').transforms.map((t) => t.id)).toEqual([
      'base64',
      'hex',
    ]);
  });

  it('M1-10 AC-4 queue patterns are exact or have one wildcard, and never backtrack', () => {
    expect(queueMatches('orders', 'orders')).toBe(true);
    expect(queueMatches('orders', 'orders.dlq')).toBe(false);
    expect(queueMatches('orders.*', 'orders.')).toBe(true);
    expect(queueMatches('orders.*', 'order')).toBe(false);
    expect(queueMatches('*.dlq', 'orders.dlq')).toBe(true);
    expect(queueMatches('a*b', 'ab')).toBe(true);
    expect(queueMatches('a*b', 'a')).toBe(false);
    expect(queueMatches('a*b*c', 'abc')).toBe(false);
    expect(queueMatches('x'.repeat(300), 'x'.repeat(300))).toBe(false);
    const rules = [
      { queue: 'a.*', codec: 'text' as const },
      { queue: 'a.b', codec: 'json' as const },
    ];
    expect(matchRule(rules, 'a.b')?.codec).toBe('text');
    expect(matchRule(rules, 'z')).toBeUndefined();
    expect(matchRule(rules, undefined)).toBeUndefined();
    expect(matchRule(undefined, 'a.b')).toBeUndefined();
    expect(matchRule([null, 3, { queue: 7 }] as never, 'a')).toBeUndefined();
  });
});
