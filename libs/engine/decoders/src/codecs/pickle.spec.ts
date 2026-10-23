import { describe, expect, it } from 'vitest';

import { decodePayload } from '../payload/decode-payload.ts';

const latin1 = (text: string): Uint8Array =>
  Uint8Array.from(Buffer.from(text, 'latin1'));

function listing(
  body: Uint8Array,
  headers: { contentType?: string } = {},
): string {
  const result = decodePayload({ body, ...headers });
  expect(result.error).toBeUndefined();
  expect(result.view.kind).toBe('disassembly');
  return result.view.kind === 'disassembly' ? result.view.text : '';
}

describe('pickle codec', () => {
  // Built by hand from the opcode table of the pickle format, protocol 2:
  // PROTO 2, EMPTY_DICT, BINPUT 0, SHORT_BINSTRING "a", BINPUT 1, BININT1 1, SETITEM, STOP.
  const dict = latin1('\x80\x02}q\x00U\x01aq\x01K\x01s.');

  it('M1-10 AC-3 prints the opcodes of a pickle and says that nothing was loaded', () => {
    const result = decodePayload({ body: dict });
    expect(result.detected).toMatchObject({ type: 'pickle', source: 'sniff' });
    expect(result.view).toMatchObject({
      kind: 'disassembly',
      deserialised: false,
    });
    const text = listing(dict);
    expect(text).toContain('Not loaded: nothing was imported, built or run.');
    expect(text).toContain('protocol 2, 8 opcodes.');
    expect(text).toContain('No opcode that imports a name or calls something.');
    expect(text.split('\n').slice(4)).toEqual([
      '      0    PROTO 2',
      '      2    EMPTY_DICT',
      '      3    BINPUT 0',
      '      5    SHORT_BINSTRING "a"',
      '      8    BINPUT 1',
      '     10    BININT1 1',
      '     12    SETITEM',
      '     13    STOP',
    ]);
  });

  it('M1-10 AC-3 marks, and does not run, a pickle that would execute a command on load', () => {
    // Protocol 0: GLOBAL os system, MARK, STRING "echo pwned", TUPLE, REDUCE, STOP.
    const evil = latin1("cos\nsystem\n(S'echo pwned'\ntR.");
    const text = listing(evil, { contentType: 'application/x-python-pickle' });
    expect(text).toContain(
      '! marks opcodes that would import a name or call something if loaded (GLOBAL, REDUCE).',
    );
    expect(text).toContain('! GLOBAL "os" "system"');
    expect(text).toContain('! REDUCE');
    expect(text).toContain(`STRING "'echo pwned'"`);
    const result = decodePayload({
      body: evil,
      contentType: 'application/x-python-pickle',
    });
    expect(result.view).toMatchObject({ deserialised: false });
    expect(result.error).toBeUndefined();

    // Protocol 4 spelling of the same idea: STACK_GLOBAL then REDUCE.
    const modern = latin1(
      '\x80\x04\x8c\x02os\x8c\x06system\x93\x8c\x04true\x85R.',
    );
    const modernText = listing(modern);
    expect(modernText).toContain('(STACK_GLOBAL, REDUCE)');
    expect(modernText).toContain('! STACK_GLOBAL');
  });

  it('M1-10 AC-3 reads every argument shape without running anything', () => {
    const body = Buffer.concat([
      Buffer.from('\x80\x05\x95', 'latin1'),
      Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]), // FRAME 1
      Buffer.from('J', 'latin1'),
      Buffer.from([0xff, 0xff, 0xff, 0xff]), // BININT -1
      Buffer.from('M', 'latin1'),
      Buffer.from([0x34, 0x12]), // BININT2
      Buffer.from('G', 'latin1'),
      Buffer.from([0x3f, 0xf8, 0, 0, 0, 0, 0, 0]), // BINFLOAT 1.5
      Buffer.from('\x8a\x02\x00\x01', 'latin1'), // LONG1 256
      Buffer.from('B', 'latin1'),
      Buffer.from([3, 0, 0, 0]),
      Buffer.from('abc', 'latin1'), // BINBYTES
      Buffer.from('Xhello\n', 'latin1').subarray(0, 1),
      Buffer.from([2, 0, 0, 0]),
      Buffer.from('hi', 'latin1'), // BINUNICODE
      Buffer.from('I42\n.', 'latin1'),
    ]);
    const text = listing(Uint8Array.from(body));
    expect(text).toContain('FRAME 1');
    expect(text).toContain('BININT -1');
    expect(text).toContain('BININT2 4660');
    expect(text).toContain('BINFLOAT 1.5');
    expect(text).toContain('LONG1 2 bytes');
    expect(text).toContain('BINBYTES "abc"');
    expect(text).toContain('BINUNICODE "hi"');
    expect(text).toContain('INT "42"');
  });

  it('M1-10 AC-3 refuses a pickle that is cut off, unknown, or lies about a length', () => {
    const bad = [
      '\x80\x02}q\x00', // no STOP
      '\x80\x02Z.', // unknown opcode
      '\x80\x04\x8c\x20abc.', // string longer than what is left
      '\x80\x02X\xff\xff\xff\xff.', // negative length
      '\x80\x04\x8e\xff\xff\xff\xff\xff\xff\xff\xff.',
      'cos\nsystem', // no newline after the second line
    ];
    for (const text of bad) {
      const result = decodePayload({
        body: latin1(text),
        contentType: 'application/x-python-pickle',
      });
      expect(result.error?.code, JSON.stringify(text)).toBe('MALFORMED_PICKLE');
      expect(result.view.kind).toBe('hex');
    }
  });

  it('M1-10 AC-3 reports what follows STOP and stops at the value limit', () => {
    const text = listing(latin1('\x80\x02N.garbage'));
    expect(text).toContain('7 bytes after STOP, not read');
    const many = latin1(`\x80\x02${'N0'.repeat(500)}.`);
    const limited = decodePayload({ body: many, limits: { maxNodes: 100 } });
    expect(limited.error?.code).toBe('NODE_LIMIT');
    const cut = decodePayload({ body: many, limits: { maxViewBytes: 600 } });
    expect(cut.view.kind).toBe('disassembly');
    expect(cut.truncations.some((t) => t.what === 'view')).toBe(true);
    expect(cut.counters.viewBytes).toBeLessThanOrEqual(600);
  });
});
