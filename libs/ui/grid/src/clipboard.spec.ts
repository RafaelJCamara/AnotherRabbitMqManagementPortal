import { describe, expect, it } from 'vitest';

import {
  buildCopyText,
  copyRows,
  GRID_MAX_COPY_ROWS,
  quoteCell,
  type GridClipboard,
} from './clipboard';
import { resolveColumns, type GridColumn } from './columns';
import { GRID_MAX_SELECTION } from './selection';

interface Row {
  readonly name: string;
  readonly size: number | null;
  readonly token: string;
}

// `token` is masked by the engine before it reaches the UI; `hidden` is a column the user hid.
const COLUMNS = resolveColumns<Row>([
  { id: 'name', header: 'Name', value: (r) => r.name },
  {
    id: 'size',
    header: 'Size',
    value: (r) => r.size,
    format: (v) => (v === null ? 'n/a' : `${String(v)} msg`),
  },
  { id: 'token', header: 'Token', value: (r) => r.token },
] satisfies GridColumn<Row>[]);

const row = (name: string, size: number | null, token = '********'): Row => ({
  name,
  size,
  token,
});

function recording(): GridClipboard & { readonly written: string[] } {
  const written: string[] = [];
  return {
    written,
    writeText: (text) => {
      written.push(text);
      return Promise.resolve();
    },
  };
}

describe('grid clipboard', () => {
  it('M0-53 AC-11 copy writes the displayed values, is capped and reports failure', async () => {
    const rows = [row('orders', 3), row('billing', null), row('audit', 8)];
    // The visible columns only: the user hid `size`, so its values are not in the text.
    const visible = COLUMNS.filter((c) => c.id !== 'size');
    const clipboard = recording();
    const copied = await copyRows(clipboard, visible, rows, 3);
    expect(copied).toEqual({ kind: 'copied', rows: 3 });
    expect(clipboard.written).toEqual([
      'orders\t********\nbilling\t********\naudit\t********',
    ]);

    // The displayed value, not the raw one: formatted, and the masked value as the engine sent it.
    expect(buildCopyText(COLUMNS, rows).text).toBe(
      'orders\t3 msg\t********\nbilling\tn/a\t********\naudit\t8 msg\t********',
    );

    // A cell with a tab, a line break or a quote is quoted, and quotes are doubled.
    expect(quoteCell('a\tb')).toBe('"a\tb"');
    expect(quoteCell('a\nb')).toBe('"a\nb"');
    expect(quoteCell('say "hi"')).toBe('"say ""hi"""');
    expect(quoteCell('plain')).toBe('plain');
    expect(buildCopyText(COLUMNS.slice(0, 1), [row('a\tb', 1)]).text).toBe(
      '"a\tb"',
    );

    // Past the cap the text stops, and the outcome says how many rows were left out.
    const many = Array.from({ length: 7 }, (_, i) => row(`q${String(i)}`, i));
    const capped = recording();
    expect(await copyRows(capped, visible, many, 7, 3)).toEqual({
      kind: 'truncated',
      rows: 3,
      omitted: 4,
    });
    expect(capped.written[0]?.split('\n')).toHaveLength(3);
    // Rows that were selected but are not loaded are left out the same way, and counted.
    expect(await copyRows(recording(), visible, rows, 5)).toEqual({
      kind: 'truncated',
      rows: 3,
      omitted: 2,
    });

    // A clipboard that refuses is a failure with its reason, never silence.
    const refusing: GridClipboard = {
      writeText: () => Promise.reject(new Error('not allowed')),
    };
    const failed = await copyRows(refusing, visible, rows, 3);
    expect(failed.kind).toBe('failed');
    expect(failed.kind === 'failed' && String(failed.reason)).toContain(
      'not allowed',
    );
  });

  it('the copy cap is the number of rows that can be resident', () => {
    expect(GRID_MAX_COPY_ROWS).toBe(GRID_MAX_SELECTION);
    expect(GRID_MAX_COPY_ROWS).toBe(5000);
    const huge = Array.from({ length: 5002 }, (_, i) =>
      row(`q${String(i)}`, i),
    );
    expect(buildCopyText(COLUMNS, huge).rows).toBe(5000);
  });

  it('copies markup and formula-like values verbatim, as text (AC-9, OQ-549)', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    expect(buildCopyText(COLUMNS.slice(0, 1), [row(hostile, 1)]).text).toBe(
      hostile,
    );
    expect(buildCopyText(COLUMNS.slice(0, 1), [row('=1+1', 1)]).text).toBe(
      '=1+1',
    );
  });

  it('writes an empty text for no rows and takes no negative cap', () => {
    expect(buildCopyText(COLUMNS, [])).toEqual({ text: '', rows: 0 });
    expect(buildCopyText(COLUMNS, [row('a', 1)], -5)).toEqual({
      text: '',
      rows: 0,
    });
  });
});
