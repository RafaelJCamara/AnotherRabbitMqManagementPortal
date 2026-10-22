import { describe, expect, it } from 'vitest';

import { PALETTE_LIMIT, rankCommands, toRanges } from './fuzzy';

const item = (id: string, title: string) => ({ id, title });

const COMMANDS = [
  item('database.backup.upload', 'Upload a database backup'),
  item('account.balance.read', 'Read the balance'),
  item('go.explorer.queues', 'Go to queues'),
  item('account.balance.update', 'Change the balance'),
  item('view.toggle-theme', 'Toggle theme'),
];

describe('rankCommands', () => {
  it('M1-41 AC-1 abau ranks account.balance.update first with highlights', () => {
    const ranked = rankCommands('abau', COMMANDS);

    expect(ranked[0]?.item.id).toBe('account.balance.update');
    // Highlights belong to the text that matched: the id, since the title has no a-b-a-u in order.
    expect(ranked[0]?.matchedIn).toBe('id');
    const id = 'account.balance.update';
    const highlighted = (ranked[0]?.ranges ?? []).map(([start, end]) =>
      id.slice(start, end),
    );
    expect(highlighted.join('')).toBe('abau');
    // The start of the id, the start of `balance` with the `a` after it, then the start of `update`.
    expect(ranked[0]?.ranges).toEqual([
      [0, 1],
      [8, 10],
      [16, 17],
    ]);
    // An item without every character in order is absent, not ranked last.
    expect(ranked.map((r) => r.item.id)).not.toContain('go.explorer.queues');
    expect(ranked.map((r) => r.item.id)).not.toContain('view.toggle-theme');
    // A scattered match of the same letters comes after.
    expect(ranked.map((r) => r.item.id).slice(0, 2)).toEqual([
      'account.balance.update',
      'database.backup.upload',
    ]);
  });

  it('returns the commands in their order for an empty or blank query', () => {
    expect(rankCommands('', COMMANDS).map((r) => r.item.id)).toEqual(
      COMMANDS.map((c) => c.id),
    );
    expect(rankCommands('   ', COMMANDS)).toHaveLength(COMMANDS.length);
    expect(rankCommands('', COMMANDS)[0]?.ranges).toEqual([]);
  });

  it('matches without case and ignores spaces in the query', () => {
    const ranked = rankCommands('GO queues', COMMANDS);
    expect(ranked[0]?.item.id).toBe('go.explorer.queues');
    expect(ranked[0]?.matchedIn).toBe('title');
  });

  it('prefers word starts and a title match to scattered characters', () => {
    const ranked = rankCommands('tt', [
      item('a.b', 'Settle the thing'),
      item('c.d', 'Toggle theme'),
    ]);
    expect(ranked.map((r) => r.item.id)).toEqual(['c.d', 'a.b']);
  });

  it('keeps the input order for equal scores and draws at most the limit', () => {
    const many = Array.from({ length: PALETTE_LIMIT + 20 }, (_, n) =>
      item(`same.cmd${String(n)}`, 'Same'),
    );
    const ranked = rankCommands('same', many);
    expect(ranked).toHaveLength(PALETTE_LIMIT);
    expect(ranked.map((r) => r.item.id)).toEqual(
      many.slice(0, PALETTE_LIMIT).map((c) => c.id),
    );
    expect(rankCommands('', many)).toHaveLength(PALETTE_LIMIT);
  });

  it('finds nothing for a query no command spells', () => {
    expect(rankCommands('zzz', COMMANDS)).toEqual([]);
  });

  it('merges consecutive positions into ranges', () => {
    expect(toRanges([0, 1, 2, 5, 7, 8])).toEqual([
      [0, 3],
      [5, 6],
      [7, 9],
    ]);
  });
});
