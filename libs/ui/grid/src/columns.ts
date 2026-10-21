/** Cell value types the grid shows. Text only: a cell is never markup (ADR-021). */
export type GridCellValue = string | number | boolean | null | undefined;

export interface GridColumn<Row> {
  readonly id: string;
  readonly header: string; // already translated
  /** A function. A string expression is not representable (AG Grid would call `new Function`, ADR-021). */
  readonly value: (row: Row) => GridCellValue;
  readonly format?: (value: GridCellValue) => string;
  readonly width?: number;
  readonly minWidth?: number;
  readonly sortable?: boolean;
  readonly hidden?: boolean;
  readonly align?: 'start' | 'end';
}

export interface ResolvedColumn<Row> {
  readonly id: string;
  readonly header: string;
  readonly value: (row: Row) => GridCellValue;
  readonly format: ((value: GridCellValue) => string) | undefined;
  readonly width: number;
  readonly minWidth: number;
  readonly sortable: boolean;
  readonly hidden: boolean;
  readonly align: 'start' | 'end';
}

export const COLUMN_DEFAULT_WIDTH = 160;
export const COLUMN_MIN_WIDTH = 40;

export class GridColumnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GridColumnError';
  }
}

/** Validates features' columns before any of them reaches AG Grid; fails closed on a string expression. */
export function resolveColumns<Row>(
  columns: readonly GridColumn<Row>[],
): readonly ResolvedColumn<Row>[] {
  const seen = new Set<string>();
  return columns.map((c) => {
    if (typeof c.id !== 'string' || c.id === '')
      throw new GridColumnError('A grid column needs a non-empty id.');
    if (seen.has(c.id))
      throw new GridColumnError(`Duplicate grid column id "${c.id}".`);
    seen.add(c.id);
    if (typeof c.value !== 'function') {
      throw new GridColumnError(
        `Column "${c.id}": value must be a function; string expressions are not supported.`,
      );
    }
    if (c.format !== undefined && typeof c.format !== 'function') {
      throw new GridColumnError(`Column "${c.id}": format must be a function.`);
    }
    const minWidth = Math.max(
      COLUMN_MIN_WIDTH,
      finiteOr(c.minWidth, COLUMN_MIN_WIDTH),
    );
    return {
      id: c.id,
      header: c.header,
      value: c.value,
      format: c.format,
      width: Math.max(minWidth, finiteOr(c.width, COLUMN_DEFAULT_WIDTH)),
      minWidth,
      sortable: c.sortable === true,
      hidden: c.hidden === true,
      align: c.align ?? 'start',
    };
  });
}

/** The text a cell displays: formatted when the column formats, empty for null and undefined. */
export function cellText<Row>(column: ResolvedColumn<Row>, row: Row): string {
  const value = column.value(row);
  if (column.format) return column.format(value);
  return value === null || value === undefined ? '' : String(value);
}

function finiteOr(n: number | undefined, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}
