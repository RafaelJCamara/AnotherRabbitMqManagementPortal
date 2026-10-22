// What an entity page shows of a row (M1-42, R7): the fields the inventory carries, grouped by tab, and the
// words for them. A field the broker did not send reads "not reported", never `0`, `false` or blank; a
// real `0` and a real `false` read as they are; a name that is the empty string is said, not left blank.
// The labels are the grid's column headers (`explorer.columns.<id>`), so a field is called the same
// everywhere. Pure functions: the page and the copy as text use the same ones.
import {
  DEFAULT_EXCHANGE_LABEL,
  type ExplorerKind,
  type InventoryRow,
} from '@app/explorer-model';

import type { Translate } from '../translate';

export type FieldValue = string | number | boolean | undefined;

export interface FieldDef {
  /** The engine's field name, also the id of its column header. */
  readonly id: string;
  readonly value: FieldValue;
}

export type FieldTab = 'overview' | 'config' | 'consumers';

const OVERVIEW: Readonly<Record<ExplorerKind, readonly string[]>> = {
  queues: [
    'name',
    'vhost',
    'type',
    'state',
    'node',
    'messages',
    'messagesReady',
    'messagesUnacknowledged',
    'consumers',
  ],
  exchanges: ['name', 'vhost', 'type'],
  connections: [
    'name',
    'vhost',
    'user',
    'node',
    'state',
    'protocol',
    'channels',
    'peerHost',
    'ssl',
  ],
  bindings: [
    'source',
    'destination',
    'destinationType',
    'routingKey',
    'vhost',
    'propertiesKey',
    'argumentsKey',
    'argumentsTruncated',
  ],
};

const CONFIG: Readonly<Record<ExplorerKind, readonly string[]>> = {
  queues: [
    'durable',
    'autoDelete',
    'exclusive',
    'policy',
    'operatorPolicy',
    'deliveryLimit',
  ],
  exchanges: ['durable', 'autoDelete', 'internal'],
  connections: [],
  bindings: [],
};

const CONSUMERS: Readonly<Record<ExplorerKind, readonly string[]>> = {
  queues: ['consumers'],
  exchanges: [],
  connections: [],
  bindings: [],
};

type Row = Readonly<Record<string, unknown>>;

function valueOf(row: InventoryRow, id: string): FieldValue {
  const value = (row as unknown as Row)[id];
  return typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
    ? value
    : undefined;
}

/** The fields of one tab of an entity, in display order. */
export function fieldsOf(
  kind: ExplorerKind,
  tab: FieldTab,
  row: InventoryRow,
): FieldDef[] {
  const ids =
    tab === 'overview'
      ? OVERVIEW[kind]
      : tab === 'config'
        ? CONFIG[kind]
        : CONSUMERS[kind];
  return ids.map((id) => ({ id, value: valueOf(row, id) }));
}

const numbers = new Intl.NumberFormat();

/** The words a field is shown (and copied) with. */
export function formatField(
  id: string,
  value: FieldValue,
  t: Translate,
): string {
  if (value === undefined) return t('explorer.cell.notReported');
  if (typeof value === 'number') return numbers.format(value);
  if (typeof value === 'boolean')
    return t(value ? 'explorer.entity.yes' : 'explorer.entity.no');
  if (value === '') {
    // The default exchange has no name; an empty routing key or arguments is empty, not missing.
    return id === 'name' || id === 'source'
      ? DEFAULT_EXCHANGE_LABEL
      : t('explorer.entity.empty');
  }
  return value;
}

/** The label of a field: its column header. */
export function fieldLabel(id: string, t: Translate): string {
  return t(`explorer.columns.${id}`);
}
