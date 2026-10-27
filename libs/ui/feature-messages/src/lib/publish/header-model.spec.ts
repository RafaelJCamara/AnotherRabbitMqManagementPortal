import type { PublishHeaders } from '@app/contracts';
import { describe, expect, it } from 'vitest';

import {
  containerDepth,
  headersToJson,
  headersToRows,
  isHeaderType,
  newRow,
  parseHeadersJson,
  rowValue,
  rowsToHeaders,
} from './header-model';
import { HEADER_TYPES, type HeaderType } from './limits';

const valueOf = (type: HeaderType, text: string) =>
  rowValue(newRow('n', type, text));

describe('header rows', () => {
  it('turns each AMQP type into its typed value, and refuses what does not fit', () => {
    const good: [HeaderType, string, unknown][] = [
      ['string', ' kept as typed ', ' kept as typed '],
      ['byte', ' -5 ', -5],
      ['short', '300', 300],
      ['int', '0', 0],
      ['long', '9007199254740991', 9007199254740991],
      ['timestamp', '1700000000', 1700000000],
      ['float', '1e3', 1000],
      ['double', '-.5', -0.5],
      ['bool', ' false ', false],
      ['bytes', ' aGk= ', 'aGk='],
      ['bytes', '', ''],
      ['void', 'ignored', null],
      ['decimal', '{"places":2,"digits":150}', { places: 2, digits: 150 }],
      [
        'array',
        '[{"value":{"t":"int","v":1}}]',
        [{ value: { t: 'int', v: 1 } }],
      ],
      [
        'table',
        '[{"name":"k","value":{"t":"bool","v":true}}]',
        [{ name: 'k', value: { t: 'bool', v: true } }],
      ],
    ];
    for (const [type, text, v] of good) {
      expect(valueOf(type, text), `${type} ${text}`).toEqual({
        value: { t: type, v },
      });
    }
    const bad: [HeaderType, string][] = [
      ['long', '1.5'],
      ['long', ''],
      ['long', '9007199254740993'],
      ['timestamp', '-1'],
      ['double', 'abc'],
      ['double', ''],
      ['double', '0x10'],
      ['double', 'Infinity'],
      ['bool', 'yes'],
      ['bytes', 'not base64!'],
      ['string', 'x'.repeat(65_536)],
      ['decimal', '{"places":300,"digits":1}'],
      ['decimal', '{'],
      ['array', '[{"name":"x","value":{"t":"int","v":1}}]'],
      ['table', '[{"value":{"t":"int","v":1}}]'],
    ];
    for (const [type, text] of bad) {
      expect(valueOf(type, text), `${type} ${text}`).toEqual({
        code: 'bad-value',
      });
    }
  });

  it('counts nested lists and tables up to the depth of the contract', () => {
    const nest = (levels: number): string => {
      let text = '[]';
      for (let level = 1; level < levels; level++) {
        text = `[{"value":{"t":"array","v":${text}}}]`;
      }
      return text;
    };
    expect(containerDepth({ t: 'string', v: 'x' })).toBe(0);
    expect(containerDepth(null)).toBe(0);
    expect(containerDepth({ t: 'array', v: [] })).toBe(1);
    expect(containerDepth({ t: 'array', v: 'no list' })).toBe(0);
    expect(
      containerDepth({ t: 'table', v: [null, { value: { t: 'int', v: 1 } }] }),
    ).toBe(1);
    expect(valueOf('array', nest(8))).toHaveProperty('value');
    expect(valueOf('array', nest(9))).toEqual({ code: 'too-deep' });
    // Deep hostile input stops at the limit instead of being walked to the bottom.
    expect(
      containerDepth(
        JSON.parse(
          `${'{"t":"array","v":[{"value":'.repeat(5000)}1${'}]}'.repeat(5000)}`,
        ),
      ),
    ).toBe(9);
  });

  it('builds the table, flags a duplicate or empty name, and keeps the order', () => {
    const rows = [newRow('b', 'int', '2'), newRow('a', 'string', 's')];
    const built = rowsToHeaders(rows);
    expect(built).toEqual({
      ok: true,
      headers: { b: { t: 'int', v: 2 }, a: { t: 'string', v: 's' } },
    });
    expect(built.ok && Object.keys(built.headers)).toEqual(['b', 'a']);

    const dup = [newRow('a', 'string', '1'), newRow('a', 'string', '2')];
    expect(rowsToHeaders(dup)).toEqual({
      ok: false,
      issues: [{ rowId: dup[1]?.id, name: 'a', code: 'duplicate' }],
    });
    const long = newRow('n'.repeat(256));
    expect(rowsToHeaders([long])).toEqual({
      ok: false,
      issues: [
        { rowId: long.id, name: long.name, code: 'too-long', limit: 255 },
      ],
    });
    expect(rowsToHeaders([newRow('n'.repeat(255))]).ok).toBe(true);
    expect(
      rowsToHeaders(
        Array.from({ length: 64 }, (_, i) => newRow(`h${String(i)}`)),
      ).ok,
    ).toBe(true);
  });

  it('turns a typed table back into rows with the text a person would type', () => {
    const rows = headersToRows({
      s: { t: 'string', v: 'x' },
      l: { t: 'long', v: 5 },
      f: { t: 'float', v: 1.5 },
      b: { t: 'bool', v: false },
      y: { t: 'bytes', v: 'aGk=' },
      v: { t: 'void', v: null },
      d: { t: 'decimal', v: { places: 1, digits: 2 } },
      t: { t: 'timestamp', v: 7 },
      u: { t: 'bool', v: true },
    });
    expect(rows.map(({ name, type, text }) => [name, type, text])).toEqual([
      ['s', 'string', 'x'],
      ['l', 'long', '5'],
      ['f', 'float', '1.5'],
      ['b', 'bool', 'false'],
      ['y', 'bytes', 'aGk='],
      ['v', 'void', ''],
      ['d', 'decimal', '{"places":1,"digits":2}'],
      ['t', 'timestamp', '7'],
      ['u', 'bool', 'true'],
    ]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  });

  it('reads the typed table written as JSON, and says which way it is wrong', () => {
    const headers: PublishHeaders = {
      a: { t: 'long', v: 1 },
      b: { t: 'string', v: 'x' },
    };
    expect(parseHeadersJson(JSON.stringify(headers))).toEqual({
      ok: true,
      headers,
    });
    expect(parseHeadersJson('')).toEqual({ ok: true, headers: {} });
    expect(parseHeadersJson('  \n ')).toEqual({ ok: true, headers: {} });
    expect(parseHeadersJson('{')).toEqual({ ok: false, error: 'json' });
    expect(parseHeadersJson('[]')).toEqual({ ok: false, error: 'shape' });
    expect(parseHeadersJson('{"a":1}')).toEqual({ ok: false, error: 'shape' });
    expect(parseHeadersJson('{"a":{"t":"long","v":"1"}}')).toEqual({
      ok: false,
      error: 'shape',
    });
    expect(JSON.parse(headersToJson(headers))).toEqual(headers);
    expect(headersToJson(headers)).toContain('\n  "a"');
  });

  it('knows exactly the AMQP types it offers', () => {
    for (const type of HEADER_TYPES) expect(isHeaderType(type)).toBe(true);
    expect(isHeaderType('object')).toBe(false);
    expect(isHeaderType('')).toBe(false);
  });
});
