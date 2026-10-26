import { describe, expect, it } from 'vitest';

import { utf8ByteLength } from './byte-size';

describe('utf8ByteLength', () => {
  it('M1-46 slice B counts bytes the way TextEncoder does, lone surrogates included', () => {
    const samples = [
      '',
      'a',
      'é',
      '€',
      '😀',
      'a😀b',
      '\ud83d',
      '\ude00',
      '\ud83d😀',
      '\ude00\ud83d',
      '\u007f\u0080߿ࠀ￿',
    ];
    // The edges of every range the counter switches on.
    for (const unit of [0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000]) {
      const char = String.fromCharCode(unit);
      samples.push(char, char + '\udc00', '\ud800' + char, char + char);
    }
    let seed = 12345;
    const next = (): number => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
    for (let i = 0; i < 300; i++) {
      samples.push(
        Array.from({ length: next() % 12 }, () =>
          String.fromCharCode(next() % 0x10000),
        ).join(''),
      );
    }
    for (const sample of samples) {
      expect(utf8ByteLength(sample)).toBe(
        new TextEncoder().encode(sample).length,
      );
    }
  });
});
