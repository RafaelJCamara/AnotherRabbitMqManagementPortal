import { describe, expect, it } from 'vitest';

import {
  COLUMN_MAX_WIDTH,
  hideColumn,
  moveColumn,
  normalizeColumnState,
  resizeColumn,
  showColumn,
} from './column-state';
import { resolveColumns } from './columns';

const columns = resolveColumns<{ a: string }>([
  { id: 'name', header: 'Name', value: (r) => r.a, sortable: true },
  { id: 'vhost', header: 'Vhost', value: (r) => r.a },
  { id: 'state', header: 'State', value: (r) => r.a, hidden: true },
]);

describe('column state', () => {
  it('M0-53 AC-12 column state round-trips and tolerates what it does not know', () => {
    const state = normalizeColumnState(
      {
        version: 1,
        columns: [
          { id: 'ghost', width: 100 },
          { id: 'vhost', width: 99_999 },
          { id: 'vhost', width: 100 },
          { id: 'name', width: 1, hidden: true, pinned: 'left' },
        ],
        sort: [
          { columnId: 'name', direction: 'desc' },
          { columnId: 'vhost', direction: 'asc' }, // not sortable
          { columnId: 'name', direction: 'asc' }, // duplicate
        ],
      },
      columns,
    );
    expect(state.columns.map((c) => c.id)).toEqual(['vhost', 'name', 'state']);
    expect(state.columns[0]?.width).toBe(COLUMN_MAX_WIDTH);
    expect(state.columns[1]).toMatchObject({
      width: 40,
      hidden: true,
      pinned: 'left',
    });
    expect(state.sort).toEqual([{ columnId: 'name', direction: 'desc' }]);

    // not an object, wrong version: the default
    expect(normalizeColumnState('x', columns).columns.map((c) => c.id)).toEqual(
      ['name', 'vhost', 'state'],
    );
    expect(normalizeColumnState({ version: 2 }, columns).sort).toEqual([]);

    // every column hidden: the first comes back
    const hidden = normalizeColumnState(
      {
        version: 1,
        columns: columns.map((c) => ({ id: c.id, hidden: true })),
        sort: [],
      },
      columns,
    );
    expect(
      hidden.columns.filter((c) => c.hidden !== true).map((c) => c.id),
    ).toEqual(['name']);

    // chooser operations keep one column visible, and every result applies to a fresh grid unchanged
    let s = hideColumn(hideColumn(state, 'vhost'), 'name'); // 'state' is hidden by default
    expect(s.columns.filter((c) => c.hidden !== true).map((c) => c.id)).toEqual(
      ['vhost'],
    );
    s = hideColumn(s, 'vhost'); // the last visible column stays
    expect(s.columns.filter((c) => c.hidden !== true)).toHaveLength(1);
    s = moveColumn(showColumn(s, 'state'), 'state', 0);
    s = resizeColumn(s, columns, 'state', 300);
    expect(s.columns.map((c) => c.id)).toEqual(['state', 'vhost', 'name']);
    expect(s.columns[0]?.width).toBe(300);
    expect(resizeColumn(s, columns, 'state', Number.NaN)).toBe(s);
    expect(
      normalizeColumnState(JSON.parse(JSON.stringify(s)), columns),
    ).toEqual(s);
  });
});
