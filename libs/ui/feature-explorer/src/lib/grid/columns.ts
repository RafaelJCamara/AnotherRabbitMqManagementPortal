// The grid columns of the four inventory kinds (M0-54, R7). Column ids are the engine's column
// names, so a `GridSort.columnId` is an `InventorySort.column`. Cells are text; a field the broker
// did not send reads "not reported", never `0`, `false` or blank; numbers use `Intl.NumberFormat`.
import {
  COLUMNS_BY_KIND,
  type ExplorerKind,
  type InventoryRow,
} from '@app/explorer-model';
import type { GridCellValue, GridColumn } from '@app/ui-grid';

import type { Translate } from '../translate';

/** Width in pixels of the columns that need more or less than the default. */
const WIDTHS: Readonly<Record<string, number>> = {
  name: 280,
  source: 220,
  destination: 220,
  routingKey: 200,
  argumentsKey: 260,
  propertiesKey: 200,
  peerHost: 160,
  policy: 150,
  operatorPolicy: 150,
  vhost: 130,
  type: 110,
  state: 110,
  messagesReady: 110,
  messagesUnacknowledged: 150,
  messages: 110,
  consumers: 100,
  channels: 100,
  deliveryLimit: 120,
  durable: 100,
  autoDelete: 110,
  exclusive: 100,
  internal: 100,
  ssl: 80,
};

/** Columns whose values are counts: end-aligned. */
const NUMERIC = new Set([
  'messages',
  'messagesReady',
  'messagesUnacknowledged',
  'consumers',
  'channels',
  'deliveryLimit',
]);

const numbers = new Intl.NumberFormat();

type Row = Readonly<Record<string, unknown>>;

function cellValue(row: InventoryRow, id: string): GridCellValue {
  const value = (row as Row)[id];
  return typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
    ? value
    : undefined;
}

/**
 * The columns of one kind, in display order, with their default visibility and sortability from the
 * model. `t` supplies the headers and the words of a cell (`explorer.columns.*`, `explorer.cell.*`).
 */
export function inventoryColumns(
  kind: ExplorerKind,
  t: Translate,
): GridColumn<InventoryRow>[] {
  const notReported = t('explorer.cell.notReported');
  const cut = t('explorer.cell.cut');
  return COLUMNS_BY_KIND[kind].map((spec): GridColumn<InventoryRow> => {
    const { id } = spec;
    const width = WIDTHS[id];
    return {
      id,
      header: t(`explorer.columns.${id}`),
      // A cut canonical form says so; the rest is the broker's value as sent.
      value:
        id === 'argumentsKey'
          ? (row) => {
              const value = cellValue(row, id);
              return typeof value === 'string' &&
                cellValue(row, 'argumentsTruncated') === true
                ? `${value} ${cut}`
                : value;
            }
          : (row) => cellValue(row, id),
      format: (value) =>
        value === undefined || value === null
          ? notReported
          : typeof value === 'number'
            ? numbers.format(value)
            : String(value),
      sortable: spec.sortable,
      hidden: spec.hiddenByDefault,
      ...(width === undefined ? {} : { width }),
      ...(NUMERIC.has(id) ? { align: 'end' as const } : {}),
    };
  });
}
