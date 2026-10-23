import { describe, expect, it } from 'vitest';

import { decodePayload } from '../payload/decode-payload.ts';
import { scanJson } from './json.ts';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const json = (text: string, limits = {}) =>
  decodePayload({ body: enc(text), contentType: 'application/json', limits });

describe('JSON codec', () => {
  it('M1-10 AC-5 gives a tree and a pretty text that keeps the number lexemes as written', () => {
    const result = json(
      '{"id":12345678901234567890,"a":[1,2.50,{"b":null}],"e":{},"l":[]}',
    );
    expect(result.view.kind).toBe('tree');
    if (result.view.kind !== 'tree') return;
    expect(result.view.text).toBe(
      [
        '{',
        '  "id": 12345678901234567890,',
        '  "a": [',
        '    1,',
        '    2.50,',
        '    {',
        '      "b": null',
        '    }',
        '  ],',
        '  "e": {},',
        '  "l": []',
        '}',
      ].join('\n'),
    );
    expect(result.view.value).toEqual({
      id: 12345678901234567000,
      a: [1, 2.5, { b: null }],
      e: {},
      l: [],
    });
    expect(result.truncations).toEqual([]);
    expect(result.detected).toMatchObject({
      type: 'json',
      mime: 'application/json',
    });
  });

  it('M1-10 AC-5 treats a __proto__ key as an ordinary key', () => {
    const result = json('{"__proto__":{"polluted":true},"a":1}');
    expect(result.view.kind).toBe('tree');
    if (result.view.kind !== 'tree') return;
    expect(Object.keys(result.view.value as object)).toEqual([
      '__proto__',
      'a',
    ]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('M1-10 AC-5 drops the tree and counts the truncation when the nesting passes the depth limit', () => {
    const deep = `${'['.repeat(200)}${']'.repeat(200)}`;
    const result = json(deep);
    expect(result.view.kind).toBe('text');
    expect(result.truncations).toContainEqual({
      what: 'depth',
      max: 64,
      dropped: null,
    });
    expect(result.notes).toContainEqual({ code: 'DEPTH_LIMIT', detail: 64 });
    expect(result.error).toBeUndefined();
    // A tighter caller limit is honoured; a looser one is ignored.
    expect(json('[[[1]]]', { maxDepth: 2 }).truncations[0]?.what).toBe('depth');
    expect(json(deep, { maxDepth: 100000 }).truncations[0]?.max).toBe(64);
  });

  it('M1-10 AC-5 counts the nodes and stops at the node limit', () => {
    const wide = `[${Array.from({ length: 1000 }, (_, i) => i).join(',')}]`;
    const result = json(wide, { maxNodes: 100 });
    expect(result.view.kind).toBe('text');
    expect(result.truncations).toContainEqual({
      what: 'nodes',
      max: 100,
      dropped: null,
    });
    expect(json(wide).view.kind).toBe('tree');
  });

  it('M1-10 AC-5 cuts a large document at the view limit and says how much was left out', () => {
    const big = `{"k":"${'x'.repeat(10 * 1024 * 1024)}"}`;
    const result = json(big);
    expect(result.view.kind).toBe('text');
    expect(result.counters.viewBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    const cut = result.truncations.find((t) => t.what === 'view');
    expect(cut?.dropped).toBeGreaterThan(5 * 1024 * 1024);
    expect(result.error).toBeUndefined();

    const many = `[${'"abc",'.repeat(2000)}"z"]`;
    const small = json(many, { maxViewBytes: 1000 });
    expect(small.counters.viewBytes).toBeLessThanOrEqual(1000);
    expect(small.truncations.some((t) => t.what === 'view')).toBe(true);
  });

  it('M1-10 AC-5 rejects what JSON.parse rejects, with the byte offset and no payload text', () => {
    const bad = [
      '{"a":}',
      '{"a" 1}',
      '[1,]',
      '{"a":1,}',
      '01',
      '"\\x"',
      '"line\nbreak"',
      '{"a":1} x',
      '[1 2]',
      '{1:2}',
      'tru',
      '"\\u12G4"',
      '',
    ];
    for (const text of bad) {
      let expected = true;
      try {
        JSON.parse(text);
        expected = false;
      } catch {
        // expected
      }
      expect(expected).toBe(true);
      if (text === '') continue; // an empty body is empty, not malformed
      const result = json(text);
      expect(result.error?.code, text).toBe('MALFORMED_JSON');
      expect(result.view.kind).toBe('hex');
      expect(result.error?.message).not.toContain(text.slice(0, 3));
    }
    const cut = json('{"orders":[1,2');
    expect(cut.error).toMatchObject({ code: 'MALFORMED_JSON', offset: 14 });
  });

  it('M1-10 AC-5 agrees with JSON.parse on what is valid', () => {
    const good = [
      '0',
      '-0',
      '1e5',
      '1E+5',
      '"\\ud800"',
      ' [ 1 , 2 ] ',
      'true',
      'null',
      '"\\u00e9"',
    ];
    for (const text of good) {
      expect(() => {
        JSON.parse(text);
      }).not.toThrow();
      const scan = scanJson(text, 64, 1000, 1000);
      expect(scan.stopped, text).toBeNull();
    }
  });

  it('M1-10 AC-5 reads a JSON document in UTF-16 with a BOM', () => {
    const text = '{"a":"é"}';
    const body = new Uint8Array(2 + text.length * 2);
    body[0] = 0xff;
    body[1] = 0xfe;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      body[2 + 2 * i] = code & 0xff;
      body[3 + 2 * i] = code >> 8;
    }
    const result = decodePayload({ body, contentType: 'application/json' });
    expect(result.view.kind).toBe('tree');
  });
});
