// Copy of the selected rows as text (AC-11). AG Grid's clipboard is Enterprise, so this is ours.
//
// The text is what the user sees: the displayed (formatted, masked) values of the visible columns,
// tab-separated, one row per line, and nothing the engine did not send (I-10). It is bounded (I-6)
// and nothing is lost silently (I-13): rows left out by the cap or because their block is not loaded
// are counted and reported, and a clipboard that refuses is an error the status bar shows.
import { DOCUMENT } from '@angular/common';
import { inject, InjectionToken } from '@angular/core';

import { cellText, type ResolvedColumn } from './columns';
import { GRID_MAX_SELECTION } from './selection';

/** Rows one copy holds at most; equal to the rows that can be resident (OQ-549). */
export const GRID_MAX_COPY_ROWS = GRID_MAX_SELECTION;

/**
 * Where the text goes. The default is `navigator.clipboard`, which needs a secure context and a user
 * gesture (OQ-549 c); the seam lets specs, and later the desktop bridge (M2-P15), replace it.
 */
export interface GridClipboard {
  writeText(text: string): Promise<void>;
}

export const GRID_CLIPBOARD = new InjectionToken<GridClipboard>(
  'GRID_CLIPBOARD',
  {
    providedIn: 'root',
    factory: (): GridClipboard => {
      const view = inject(DOCUMENT).defaultView;
      return {
        writeText: (text) => {
          const clipboard = view?.navigator.clipboard as
            | { writeText(text: string): Promise<void> }
            | undefined;
          return clipboard === undefined
            ? Promise.reject(
                new Error(
                  'The clipboard is not available (it needs a secure context).',
                ),
              )
            : clipboard.writeText(text);
        },
      };
    },
  },
);

/** A cell that holds a tab, a line break or a quote is quoted, with quotes doubled (the spreadsheet rule). */
export function quoteCell(value: string): string {
  return /[\t\r\n"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export interface BuiltCopy {
  readonly text: string;
  /** Rows in the text. */
  readonly rows: number;
}

/**
 * Tab-separated text of `rows` in the order given, for `columns` in the order given (the visible ones).
 * It holds at most `cap` rows. A value is copied verbatim: a value that starts with `=`, `+`, `-` or
 * `@` is not changed (the formula question of OQ-549 b is open).
 */
export function buildCopyText<Row>(
  columns: readonly ResolvedColumn<Row>[],
  rows: readonly Row[],
  cap: number = GRID_MAX_COPY_ROWS,
): BuiltCopy {
  const taken = rows.slice(0, Math.max(0, cap));
  const lines = taken.map((row) =>
    columns.map((column) => quoteCell(cellText(column, row))).join('\t'),
  );
  return { text: lines.join('\n'), rows: taken.length };
}

export type CopyOutcome =
  | { readonly kind: 'copied'; readonly rows: number }
  | {
      readonly kind: 'truncated';
      readonly rows: number;
      /** Selected rows that are not in the text: past the cap, or not loaded. */
      readonly omitted: number;
    }
  | { readonly kind: 'failed'; readonly reason: unknown };

/**
 * Copies the loaded rows of a selection of `requested` rows. Rows the text cannot hold are counted in
 * `omitted`, and a rejected write is a `failed` outcome, never a silent one.
 */
export async function copyRows<Row>(
  clipboard: GridClipboard,
  columns: readonly ResolvedColumn<Row>[],
  rows: readonly Row[],
  requested: number,
  cap: number = GRID_MAX_COPY_ROWS,
): Promise<CopyOutcome> {
  const built = buildCopyText(columns, rows, cap);
  try {
    await clipboard.writeText(built.text);
  } catch (reason: unknown) {
    return { kind: 'failed', reason };
  }
  const omitted = Math.max(0, requested - built.rows);
  return omitted > 0
    ? { kind: 'truncated', rows: built.rows, omitted }
    : { kind: 'copied', rows: built.rows };
}
