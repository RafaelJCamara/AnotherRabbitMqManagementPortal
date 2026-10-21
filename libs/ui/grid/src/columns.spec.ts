import { describe, expect, it } from 'vitest';

import {
  GridColumnError,
  cellText,
  resolveColumns,
  type GridColumn,
} from './columns';

interface Row {
  readonly size: number | null;
  readonly name: string;
}

describe('resolveColumns', () => {
  it('AC-10 a string expression is not representable', () => {
    const expression = {
      id: 'size',
      header: 'Size',
      value: 'data.size * 2',
    } as unknown as GridColumn<Row>;
    expect(() => resolveColumns([expression])).toThrow(GridColumnError);
    expect(() => resolveColumns([expression])).toThrow(
      /string expressions are not supported/,
    );
    const format = {
      id: 'a',
      header: 'A',
      value: (r: Row) => r.name,
      format: 'x',
    } as unknown as GridColumn<Row>;
    expect(() => resolveColumns([format])).toThrow(/format must be a function/);
    const ok: GridColumn<Row> = { id: 'a', header: 'A', value: (r) => r.name };
    expect(() => resolveColumns([ok, ok])).toThrow(/Duplicate/);
  });

  it('shows text for null, formatted values and defaults', () => {
    const resolved = resolveColumns<Row>([
      { id: 'size', header: 'Size', value: (r) => r.size, width: Number.NaN },
      {
        id: 'name',
        header: 'Name',
        value: (r) => r.name,
        format: (v) => `<${String(v)}>`,
        sortable: true,
      },
    ]);
    const [plain, formatted] = resolved;
    if (!plain || !formatted) throw new Error('two columns expected');
    expect(cellText(plain, { size: null, name: 'q' })).toBe('');
    expect(cellText(plain, { size: 3, name: 'q' })).toBe('3');
    expect(
      cellText(formatted, { size: 3, name: '<img src=x onerror=1>' }),
    ).toBe('<<img src=x onerror=1>>');
    expect(plain).toMatchObject({
      width: 160,
      sortable: false,
      align: 'start',
    });
    expect(formatted.sortable).toBe(true);
  });
});
