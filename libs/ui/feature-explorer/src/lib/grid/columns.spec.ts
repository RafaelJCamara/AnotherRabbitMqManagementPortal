import {
  COLUMNS_BY_KIND,
  EXPLORER_KINDS,
  type ExplorerKind,
  type InventoryRow,
} from '@app/explorer-model';
import { cellText, resolveColumns } from '@app/ui-grid';
import { describe, expect, it } from 'vitest';

import { translate } from '../testing/translate';
import { inventoryColumns } from './columns';

const NOT_REPORTED = 'not reported';

function text(
  kind: ExplorerKind,
  column: string,
  row: Record<string, unknown>,
): string {
  const resolved = resolveColumns(inventoryColumns(kind, translate));
  const found = resolved.find((c) => c.id === column);
  if (!found) throw new Error(`no column ${column}`);
  return cellText(found, { key: 'k', ...row } as unknown as InventoryRow);
}

describe('inventoryColumns', () => {
  it('AC-10 cells show what the broker sent and "not reported" for what it did not', () => {
    // R7: the columns of each kind, in order, and which of them are shown by default.
    const shown = (kind: ExplorerKind): string[] =>
      inventoryColumns(kind, translate)
        .filter((c) => c.hidden !== true)
        .map((c) => c.id);
    expect(shown('queues')).toEqual([
      'name',
      'vhost',
      'type',
      'state',
      'messagesReady',
      'messagesUnacknowledged',
      'messages',
      'consumers',
      'policy',
    ]);
    expect(shown('exchanges')).toEqual([
      'name',
      'vhost',
      'type',
      'durable',
      'autoDelete',
      'internal',
    ]);
    expect(shown('connections')).toEqual([
      'name',
      'vhost',
      'user',
      'node',
      'state',
      'protocol',
      'channels',
      'peerHost',
      'ssl',
    ]);
    expect(shown('bindings')).toEqual([
      'source',
      'destination',
      'destinationType',
      'routingKey',
    ]);
    expect(
      inventoryColumns('queues', translate)
        .filter((c) => c.hidden === true)
        .map((c) => c.id),
    ).toEqual([
      'node',
      'durable',
      'autoDelete',
      'exclusive',
      'operatorPolicy',
      'deliveryLimit',
    ]);

    // A stats-off queue: the broker sent no counts, so they read "not reported", never 0.
    const statsOff = { name: 'q', vhost: '/' };
    expect(text('queues', 'messages', statsOff)).toBe(NOT_REPORTED);
    expect(text('queues', 'consumers', statsOff)).toBe(NOT_REPORTED);
    expect(text('queues', 'messagesReady', statsOff)).toBe(NOT_REPORTED);
    // A real 0 and a real false read as they are; a count is formatted for the reader.
    expect(text('queues', 'consumers', { consumers: 0 })).toBe('0');
    expect(text('queues', 'durable', { durable: false })).toBe('false');
    expect(text('queues', 'durable', { durable: true })).toBe('true');
    expect(text('queues', 'messages', { messages: 1_234_567 })).toBe(
      new Intl.NumberFormat().format(1_234_567),
    );
    // Missing optional text is not blank either.
    expect(text('connections', 'vhost', { name: 'c' })).toBe(NOT_REPORTED);
    expect(text('exchanges', 'type', { name: 'e' })).toBe(NOT_REPORTED);

    // A cut canonical form of arguments says so; an uncut one is as sent.
    expect(
      text('bindings', 'argumentsKey', {
        argumentsKey: 'x-match=all',
        argumentsTruncated: true,
      }),
    ).toBe(`x-match=all ${translate('explorer.cell.cut')}`);
    expect(
      text('bindings', 'argumentsKey', { argumentsKey: 'x-match=all' }),
    ).toBe('x-match=all');

    // A name with markup is text: the cell value is the string, and nothing here builds an element.
    const hostile = "<img src=x onerror='alert(1)'><b>q</b>";
    expect(text('queues', 'name', { name: hostile })).toBe(hostile);
  });

  it('every column of the model has a header and sorts exactly when the model says so', () => {
    for (const kind of EXPLORER_KINDS) {
      const columns = inventoryColumns(kind, translate);
      expect(columns.map((c) => c.id)).toEqual(
        COLUMNS_BY_KIND[kind].map((c) => c.id),
      );
      for (const column of columns) {
        expect(column.header).not.toBe('');
        expect(column.sortable).toBe(
          COLUMNS_BY_KIND[kind].find((c) => c.id === column.id)?.sortable,
        );
      }
    }
  });
});
