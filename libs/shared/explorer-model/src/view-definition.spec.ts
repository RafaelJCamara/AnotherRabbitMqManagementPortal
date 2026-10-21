import { VIEW_DEFINITION_MAX_CHARS } from '@app/contracts';
import { describe, expect, it } from 'vitest';

import { FILTER_CAPS } from './inventory-model';
import {
  parseViewDefinition,
  serializeView,
  type ExplorerViewDefinition,
} from './view-definition';

const SAVED: ExplorerViewDefinition = {
  version: 1,
  kind: 'queues',
  filter: { text: 'orders', types: ['quorum'], hasConsumers: false },
  columns: {
    version: 1,
    columns: [
      { id: 'messages', width: 120 },
      { id: 'name', hidden: false },
      { id: 'node', hidden: true },
    ],
    sort: [{ columnId: 'messages', direction: 'desc' }],
  },
};

describe('parseViewDefinition', () => {
  it('reads what serializeView wrote, unchanged and with nothing dropped', () => {
    const serialized = serializeView(SAVED);
    expect(serialized.ok).toBe(true);
    const parsed = parseViewDefinition(
      serialized.ok ? serialized.definition : null,
      'queues',
    );
    expect(parsed.definition).toEqual(SAVED);
    expect(parsed.dropped).toEqual([]);
    expect(parsed.appliesNothing).toBe(false);
  });

  it('never throws and applies nothing for a value that is not a definition of this kind and version', () => {
    for (const raw of [
      null,
      undefined,
      42,
      'text',
      [],
      { version: 2, kind: 'queues' },
      { version: 1, kind: 'exchanges', filter: { text: 'x' } },
      { version: 1, kind: 3 },
      { version: 'one' },
      JSON.parse(`{"blob":"${'x'.repeat(20_000)}"}`) as unknown,
    ]) {
      const parsed = parseViewDefinition(raw, 'queues');
      expect(parsed.appliesNothing).toBe(true);
      expect(parsed.dropped).toHaveLength(1);
      expect(parsed.definition.filter).toEqual({});
      expect(parsed.definition.columns.columns).toEqual([]);
    }
    expect(parseViewDefinition({ version: 2 }, 'queues').dropped).toEqual([
      { what: 'newer-version' },
    ]);
    expect(
      parseViewDefinition({ version: 1, kind: 'exchanges' }, 'queues').dropped,
    ).toEqual([{ what: 'wrong-kind', detail: 'exchanges' }]);
  });

  it('drops what the kind cannot apply, names each drop and keeps the rest', () => {
    const exchanges = parseViewDefinition(
      {
        version: 1,
        kind: 'exchanges',
        filter: { text: 'ex', states: ['running'], hasConsumers: true },
        columns: {
          version: 1,
          columns: [{ id: 'name' }, { id: 'messages' }],
          sort: [{ columnId: 'messages', direction: 'asc' }],
        },
      },
      'exchanges',
    );
    expect(exchanges.definition.filter).toEqual({ text: 'ex' });
    expect(exchanges.definition.columns.columns).toEqual([{ id: 'name' }]);
    expect(exchanges.definition.columns.sort).toEqual([]);
    expect(exchanges.dropped).toEqual([
      { what: 'filter-not-for-kind', detail: 'states' },
      { what: 'filter-not-for-kind', detail: 'hasConsumers' },
      { what: 'unknown-column', detail: 'messages' },
      { what: 'unknown-column', detail: 'messages' },
    ]);

    // A list over its cap is cut and says so; a second sort column is dropped; a column that does not sort is refused.
    const capped = parseViewDefinition(
      {
        version: 1,
        kind: 'bindings',
        filter: {
          vhosts: Array.from({ length: 100 }, (_, i) => `v${String(i)}`),
        },
        columns: {
          version: 1,
          columns: [],
          sort: [
            { columnId: 'source', direction: 'asc' },
            { columnId: 'routingKey', direction: 'asc' },
            { columnId: 'argumentsKey', direction: 'asc' },
          ],
        },
      },
      'bindings',
    );
    expect(capped.definition.filter.vhosts).toHaveLength(
      FILTER_CAPS.vhostChips,
    );
    expect(capped.definition.columns.sort).toEqual([
      { columnId: 'source', direction: 'asc' },
    ]);
    expect(capped.dropped.map((d) => d.what).sort()).toEqual([
      'filter-over-cap',
      'invalid',
      'unknown-column',
    ]);
  });
});

describe('serializeView', () => {
  it('refuses a definition over the contract limit before anything is sent', () => {
    const big: ExplorerViewDefinition = {
      ...SAVED,
      filter: {
        text: 'x'.repeat(FILTER_CAPS.text),
        vhosts: Array.from({ length: 25 }, () => 'v'.repeat(255)),
        types: Array.from({ length: 16 }, () => 't'.repeat(64)),
        states: Array.from({ length: 16 }, () => 's'.repeat(32)),
      },
      columns: {
        version: 1,
        columns: Array.from({ length: 2_000 }, (_, i) => ({
          id: `column-${String(i)}`,
          width: 100,
        })),
        sort: [],
      },
    };
    expect(JSON.stringify(big).length).toBeGreaterThan(
      VIEW_DEFINITION_MAX_CHARS,
    );
    expect(serializeView(big)).toEqual({ ok: false, reason: 'too-large' });
    // 25 vhost chips alone stay well inside the limit (Q-12).
    expect(
      serializeView({
        ...SAVED,
        filter: { vhosts: Array.from({ length: 25 }, () => 'v'.repeat(255)) },
      }).ok,
    ).toBe(true);
  });
});
