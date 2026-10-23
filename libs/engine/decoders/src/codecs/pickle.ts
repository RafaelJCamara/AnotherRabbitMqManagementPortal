// Python pickle as an opcode listing (blueprint 11, OQ-966). A pickle is a program for the
// unpickler's stack machine: loading one can run any code. This codec NEVER loads: it reads the
// opcodes and prints them, one per line, and marks the ones that would import a name or call
// something. Nothing is evaluated, imported or looked up; there is no `eval`, `Function`, `vm`
// or `child_process` anywhere in this library (a spec scans for them).
import { fail } from './errors.ts';
import type { FormatCodec, Truncation } from './types.ts';
import { fitUtf8 } from './views.ts';

type Arg =
  | 'none'
  | 'line'
  | 'line2'
  | 'u1'
  | 'u2'
  | 's4'
  | 'u4'
  | 'u8'
  | 'f8'
  | 'bytes1'
  | 'bytes4'
  | 'bytes8'
  | 'long1'
  | 'long4';

const OPCODES = new Map<number, [name: string, arg: Arg]>(
  (
    [
      ['(', 'MARK', 'none'],
      ['.', 'STOP', 'none'],
      ['0', 'POP', 'none'],
      ['1', 'POP_MARK', 'none'],
      ['2', 'DUP', 'none'],
      ['F', 'FLOAT', 'line'],
      ['I', 'INT', 'line'],
      ['J', 'BININT', 's4'],
      ['K', 'BININT1', 'u1'],
      ['L', 'LONG', 'line'],
      ['M', 'BININT2', 'u2'],
      ['N', 'NONE', 'none'],
      ['P', 'PERSID', 'line'],
      ['Q', 'BINPERSID', 'none'],
      ['R', 'REDUCE', 'none'],
      ['S', 'STRING', 'line'],
      ['T', 'BINSTRING', 'bytes4'],
      ['U', 'SHORT_BINSTRING', 'bytes1'],
      ['V', 'UNICODE', 'line'],
      ['X', 'BINUNICODE', 'bytes4'],
      ['a', 'APPEND', 'none'],
      ['b', 'BUILD', 'none'],
      ['c', 'GLOBAL', 'line2'],
      ['d', 'DICT', 'none'],
      ['}', 'EMPTY_DICT', 'none'],
      ['e', 'APPENDS', 'none'],
      ['g', 'GET', 'line'],
      ['h', 'BINGET', 'u1'],
      ['i', 'INST', 'line2'],
      ['j', 'LONG_BINGET', 'u4'],
      ['l', 'LIST', 'none'],
      [']', 'EMPTY_LIST', 'none'],
      ['o', 'OBJ', 'none'],
      ['p', 'PUT', 'line'],
      ['q', 'BINPUT', 'u1'],
      ['r', 'LONG_BINPUT', 'u4'],
      ['s', 'SETITEM', 'none'],
      ['t', 'TUPLE', 'none'],
      [')', 'EMPTY_TUPLE', 'none'],
      ['u', 'SETITEMS', 'none'],
      ['G', 'BINFLOAT', 'f8'],
      ['\x80', 'PROTO', 'u1'],
      ['\x81', 'NEWOBJ', 'none'],
      ['\x82', 'EXT1', 'u1'],
      ['\x83', 'EXT2', 'u2'],
      ['\x84', 'EXT4', 'u4'],
      ['\x85', 'TUPLE1', 'none'],
      ['\x86', 'TUPLE2', 'none'],
      ['\x87', 'TUPLE3', 'none'],
      ['\x88', 'NEWTRUE', 'none'],
      ['\x89', 'NEWFALSE', 'none'],
      ['\x8a', 'LONG1', 'long1'],
      ['\x8b', 'LONG4', 'long4'],
      ['B', 'BINBYTES', 'bytes4'],
      ['C', 'SHORT_BINBYTES', 'bytes1'],
      ['\x8c', 'SHORT_BINUNICODE', 'bytes1'],
      ['\x8d', 'BINUNICODE8', 'bytes8'],
      ['\x8e', 'BINBYTES8', 'bytes8'],
      ['\x8f', 'EMPTY_SET', 'none'],
      ['\x90', 'ADDITEMS', 'none'],
      ['\x91', 'FROZENSET', 'none'],
      ['\x92', 'NEWOBJ_EX', 'none'],
      ['\x93', 'STACK_GLOBAL', 'none'],
      ['\x94', 'MEMOIZE', 'none'],
      ['\x95', 'FRAME', 'u8'],
      ['\x96', 'BYTEARRAY8', 'bytes8'],
      ['\x97', 'NEXT_BUFFER', 'none'],
      ['\x98', 'READONLY_BUFFER', 'none'],
    ] as const
  ).map(([char, name, arg]) => [char.charCodeAt(0), [name, arg]]),
);

/** The opcodes that import a name, build an object, or call something when loaded. */
const RUNS_CODE = new Set([
  'GLOBAL',
  'STACK_GLOBAL',
  'INST',
  'OBJ',
  'NEWOBJ',
  'NEWOBJ_EX',
  'REDUCE',
  'BUILD',
  'PERSID',
  'BINPERSID',
  'EXT1',
  'EXT2',
  'EXT4',
]);

const SHOWN = 80;

function quoted(bytes: Uint8Array): string {
  const text = Buffer.from(bytes.subarray(0, SHOWN)).toString('latin1');
  const shown = JSON.stringify(text);
  return bytes.length > SHOWN
    ? `${shown}... (${String(bytes.length)} bytes)`
    : shown;
}

export const pickleCodec: FormatCodec = {
  kind: 'format',
  id: 'pickle',
  mimes: [
    'application/x-python-pickle',
    'application/python-pickle',
    'application/x-pickle',
    'application/pickle',
  ],
  detect(sample) {
    // PROTO 2 to 5 opens every modern pickle; protocols 0 and 1 have no marker and are
    // recognised only by a header or a rule.
    const proto = sample[1] ?? 0;
    return sample[0] === 0x80 && proto >= 2 && proto <= 5 ? 0.9 : 0;
  },
  decode(bytes, context) {
    const { limits } = context;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const lines: string[] = [];
    const seen = new Map<string, number>();
    let at = 0;
    let count = 0;
    let used = 0;
    let stopped = false;
    let cut = false;
    let protocol: number | undefined;

    const need = (size: number): void => {
      if (size < 0 || size > bytes.length - at)
        fail('MALFORMED_PICKLE', bytes.length);
    };
    const lineAt = (): Uint8Array => {
      const end = bytes.indexOf(0x0a, at);
      if (end === -1) return fail('MALFORMED_PICKLE', bytes.length);
      const out = bytes.subarray(at, end);
      at = end + 1;
      return out;
    };

    while (at < bytes.length && !stopped) {
      if (used > limits.maxViewBytes) {
        cut = true;
        break;
      }
      if (++count > limits.maxNodes) fail('NODE_LIMIT', at);
      const start = at;
      const entry = OPCODES.get(bytes[at++] ?? 0);
      if (entry === undefined) return fail('MALFORMED_PICKLE', start);
      const [name, arg] = entry;
      let shown = '';
      switch (arg) {
        case 'none':
          break;
        case 'line':
          shown = quoted(lineAt());
          break;
        case 'line2':
          shown = `${quoted(lineAt())} ${quoted(lineAt())}`;
          break;
        case 'u1':
          need(1);
          shown = String(view.getUint8(at++));
          if (name === 'PROTO') protocol = Number(shown);
          break;
        case 'u2':
          need(2);
          shown = String(view.getUint16(at, true));
          at += 2;
          break;
        case 's4':
          need(4);
          shown = String(view.getInt32(at, true));
          at += 4;
          break;
        case 'u4':
          need(4);
          shown = String(view.getUint32(at, true));
          at += 4;
          break;
        case 'u8':
          need(8);
          shown = String(view.getBigUint64(at, true));
          at += 8;
          break;
        case 'f8':
          need(8);
          shown = String(view.getFloat64(at));
          at += 8;
          break;
        case 'bytes1':
        case 'bytes4':
        case 'bytes8': {
          const width = arg === 'bytes1' ? 1 : arg === 'bytes4' ? 4 : 8;
          need(width);
          const size =
            width === 1
              ? view.getUint8(at)
              : width === 4
                ? view.getInt32(at, true)
                : Number(view.getBigUint64(at, true));
          at += width;
          need(size);
          shown = quoted(bytes.subarray(at, at + size));
          at += size;
          break;
        }
        case 'long1':
        case 'long4': {
          const width = arg === 'long1' ? 1 : 4;
          need(width);
          const size =
            width === 1 ? view.getUint8(at) : view.getInt32(at, true);
          at += width;
          need(size);
          shown = `${String(size)} bytes`;
          at += size;
          break;
        }
      }
      if (name === 'STOP') stopped = true;
      if (RUNS_CODE.has(name)) seen.set(name, (seen.get(name) ?? 0) + 1);
      const row = `${String(start).padStart(7)}  ${RUNS_CODE.has(name) ? '!' : ' '} ${name}${shown === '' ? '' : ` ${shown}`}`;
      lines.push(row);
      used += row.length + 1;
    }
    if (!stopped && !cut) return fail('MALFORMED_PICKLE', bytes.length);

    const risky = [...seen.keys()];
    const header = [
      'Pickle opcode listing. Not loaded: nothing was imported, built or run.',
      `protocol ${protocol === undefined ? '0 or 1' : String(protocol)}, ${String(count)} opcodes${cut ? ' read before the view limit' : ''}.`,
      risky.length === 0
        ? 'No opcode that imports a name or calls something.'
        : `! marks opcodes that would import a name or call something if loaded (${risky.join(', ')}).`,
      '',
    ];
    if (stopped && at < bytes.length) {
      lines.push(
        `        ${String(bytes.length - at)} bytes after STOP, not read`,
      );
    }
    const fitted = fitUtf8(
      [...header, ...lines].join('\n'),
      limits.maxViewBytes,
    );
    const truncations: Truncation[] = [];
    if (cut || fitted.cutChars > 0) {
      truncations.push({
        what: 'view',
        max: limits.maxViewBytes,
        dropped: cut ? bytes.length - at : fitted.cutChars,
      });
    }
    return {
      view: { kind: 'disassembly', text: fitted.text, deserialised: false },
      type: 'pickle',
      mime: 'application/x-python-pickle',
      truncations,
      notes: [],
    };
  },
};
