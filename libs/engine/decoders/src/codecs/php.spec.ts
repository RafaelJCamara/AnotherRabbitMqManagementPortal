import { describe, expect, it } from 'vitest';

import { decodePayload } from '../payload/decode-payload.ts';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

function listing(text: string): string[] {
  const result = decodePayload({
    body: enc(text),
    contentType: 'application/vnd.php.serialized',
  });
  expect(result.error, text).toBeUndefined();
  expect(result.view).toMatchObject({
    kind: 'disassembly',
    deserialised: false,
  });
  return result.view.kind === 'disassembly'
    ? result.view.text.split('\n').slice(3)
    : [];
}

describe('PHP serialize() codec', () => {
  it('M1-10 AC-3 prints the values of a serialized array with their type tags', () => {
    expect(
      listing('a:4:{i:0;s:3:"foo";s:1:"b";b:1;i:7;d:0.5;s:1:"n";N;}'),
    ).toEqual([
      'array(4) {',
      '  [0] => string(3) "foo"',
      '  ["b"] => bool(true)',
      '  [7] => float(0.5)',
      '  ["n"] => NULL',
      '}',
    ]);
  });

  it('M1-10 AC-3 shows an object as a class name and members, and never instantiates it', () => {
    const lines = listing(
      'O:8:"stdClass":2:{s:1:"x";i:5;s:4:"\0*\0y";a:1:{i:0;O:3:"Foo":0:{}}}',
    );
    expect(lines).toEqual([
      'object("stdClass") (2) {',
      '  ["x"] => int(5)',
      '  ["\\0*\\0y"] => array(1) {',
      '    [0] => object("Foo") (0) {',
      '    }',
      '  }',
      '}',
    ]);
    // A class that exists nowhere is just a name; a destructor-bearing name does nothing here.
    expect(listing('O:23:"Illuminate\\Foundation\\X":0:{}')[0]).toBe(
      'object("Illuminate\\\\Foundation\\\\X") (0) {',
    );
  });

  it('M1-10 AC-3 reads enums, custom serialized objects and references', () => {
    expect(listing('E:11:"Suit:Hearts";')).toEqual(['enum("Suit:Hearts")']);
    expect(listing('C:3:"Foo":3:{abc}')).toEqual([
      'custom-serialized object("Foo") "abc"',
    ]);
    expect(listing('a:2:{i:0;i:1;i:1;R:2;}')).toEqual([
      'array(2) {',
      '  [0] => int(1)',
      '  [1] => reference to #2',
      '}',
    ]);
  });

  it('M1-10 AC-3 is sniffed for arrays, objects and strings, and by content type', () => {
    expect(decodePayload({ body: enc('a:0:{}') }).detected).toMatchObject({
      type: 'php-serialized',
      source: 'sniff',
    });
    expect(
      decodePayload({
        body: enc('i:5;'),
        contentType: 'application/vnd.php.serialized',
      }).detected,
    ).toMatchObject({ type: 'php-serialized', source: 'header' });
    // A bare "i:5;" is far too common in text to claim without a header.
    expect(decodePayload({ body: enc('i:5;') }).codec).toBe('text');
  });

  it('M1-10 AC-3 refuses what lies about a length or is cut off', () => {
    const bad = [
      's:10:"short";',
      's:3:"abcd";',
      'a:1:{i:0;}',
      'a:99999999:{}',
      'a:1:{i:0;i:1;',
      'O:3:"Foo":1:{s:1:"a";}',
      'i:;',
      'x:1;',
      'b:2;',
      'd:abc;',
      'a:1:{b:1;i:1;}',
      'N;N;',
      `s:${String(2 ** 60)}:"a";`,
    ];
    for (const text of bad) {
      const result = decodePayload({
        body: enc(text),
        contentType: 'application/vnd.php.serialized',
      });
      expect(result.error?.code, text).toBe('MALFORMED_PHP');
      expect(result.view.kind).toBe('hex');
    }
  });

  it('M1-10 AC-3 limits nesting depth', () => {
    const deep = `${'a:1:{i:0;'.repeat(200)}N;${'}'.repeat(200)}`;
    const result = decodePayload({
      body: enc(deep),
      contentType: 'application/vnd.php.serialized',
    });
    expect(result.error?.code).toBe('DEPTH_LIMIT');
  });
});
