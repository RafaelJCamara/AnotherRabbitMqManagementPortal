// The name search against a plain reference (M0-48 slice G). The fast path (cached folded names,
// an early turn-away once the shortlist is full) must give the answer the straightforward way gives.
import { encodeObjectKey } from '@app/contracts';
import { describe, expect, it } from 'vitest';

import { createInventoryIndex } from './index';
import { exchangeRow, queueRow } from './rows';
import { searchNames, type SearchSource } from './search';

/** A small deterministic generator (mulberry32), so a failure names its seed. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Letters of both cases, a letter whose lower case is two characters (the dotted capital I), one
// whose lower case differs by position (the capital sigma), accents, a dot, a dash and an astral
// character, so folding and length surprises are all in play. The alphabet is small on purpose:
// that makes many equal names, equal lengths and equal keys.
const ALPHABET = [
  'a',
  'A',
  'b',
  'B',
  '0',
  '1',
  '-',
  '.',
  'é',
  'É',
  'İ',
  'Σ',
  'ß',
  '\u{1F407}',
];
const VHOSTS = ['/', 'v1', 'V1', 'vhost-2'];

interface Item {
  kind: 'queues' | 'exchanges';
  vhost: string;
  name: string;
}

function pick<T>(rand: () => number, list: readonly T[]): T {
  return list[Math.floor(rand() * list.length)] as T;
}

function randomName(rand: () => number): string {
  const length = Math.floor(rand() * 7);
  let name = '';
  for (let i = 0; i < length; i++) name += pick(rand, ALPHABET);
  return name;
}

/** Case ties, a different case of the same text, are made on purpose. */
function flipCase(rand: () => number, text: string): string {
  return Array.from(text)
    .map((c) => (rand() < 0.5 ? c.toUpperCase() : c.toLowerCase()))
    .join('');
}

/** The plain way, written out independently of the service. */
function reference(items: readonly Item[], text: string, max: number) {
  const needle = text.toLowerCase();
  const order = ['queues', 'exchanges'];
  const rank = (n: Item) => {
    const lower = n.name.toLowerCase();
    return lower === needle ? 0 : lower.startsWith(needle) ? 1 : 2;
  };
  const key = (n: Item) => encodeObjectKey(n.vhost, n.name);
  const found = items.filter((n) => n.name.toLowerCase().includes(needle));
  found.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.name.length - b.name.length ||
      (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) ||
      order.indexOf(a.kind) - order.indexOf(b.kind),
  );
  return {
    matched: found.length,
    hits: found
      .slice(0, max)
      .map((n) => `${n.kind}|${n.vhost}|${n.name}|${String(rank(n))}`),
  };
}

describe('explorer search', () => {
  it('explorer search fast path equals the reference ranking', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rand = random(seed);
      const count = 1 + Math.floor(rand() * 220);
      const items: Item[] = Array.from({ length: count }, () => ({
        kind: rand() < 0.75 ? 'queues' : 'exchanges',
        vhost: pick(rand, VHOSTS),
        name: randomName(rand),
      }));
      // The same vhost and name in both kinds: equal keys, the kind decides.
      items.push(
        { kind: 'queues', vhost: '/', name: 'Tie' },
        { kind: 'exchanges', vhost: '/', name: 'Tie' },
      );

      const index = createInventoryIndex({
        maxRowsPerConnection: 10_000,
        maxBytesPerConnection: 1 << 30,
      });
      const meta = { sweptAt: 1, complete: true };
      // The index keeps rows in sweep order, so the references are made from what it kept.
      const queueItems = items.filter((i) => i.kind === 'queues');
      const exchangeItems = items.filter((i) => i.kind === 'exchanges');
      index.install(
        'queues',
        queueItems.map((i) => queueRow({ name: i.name, vhost: i.vhost })),
        meta,
      );
      index.install(
        'exchanges',
        exchangeItems.map((i) =>
          exchangeRow({
            name: i.name,
            vhost: i.vhost,
            type: 'direct',
            durable: true,
            auto_delete: false,
            internal: false,
          }),
        ),
        meta,
      );
      const sources: SearchSource[] = (['queues', 'exchanges'] as const).map(
        (kind) => ({
          kind,
          rows: index.rows(kind),
          folded: index.folded(kind),
        }),
      );
      // The cache is the folded names, row for row.
      for (const source of sources) {
        expect(source.folded).toEqual(
          source.rows.map((r) => r.name.toLowerCase()),
        );
      }

      const needles = [
        ...Array.from({ length: 12 }, () => {
          const item = pick(rand, items);
          const from = Math.floor(rand() * (item.name.length + 1));
          const to = from + Math.floor(rand() * (item.name.length - from + 1));
          return flipCase(rand, item.name.slice(from, to) || 'a');
        }),
        ...Array.from({ length: 4 }, () => randomName(rand) || 'b'),
        'tie',
        'TIE',
        'a',
        'İ',
        'i̇',
        'σ',
        'ς',
        '\u{1F407}',
        'zzz-not-there',
      ];
      for (const needle of needles) {
        for (const max of [1, 5, 50]) {
          const got = searchNames(sources, needle, max);
          const want = reference(items, needle, max);
          const label = `seed ${String(seed)}, text ${JSON.stringify(needle)}, max ${String(max)}`;
          expect(got.matched, label).toBe(want.matched);
          expect(
            got.hits.map(
              (h) =>
                `${h.kind}|${h.row.vhost}|${h.row.name}|${String(['exact', 'prefix', 'substring'].indexOf(h.rank))}`,
            ),
            label,
          ).toEqual(want.hits);
        }
      }
    }
  });

  it('explorer search folded names are counted, kept with the version and dropped with it', () => {
    const index = createInventoryIndex({
      maxRowsPerConnection: 100,
      maxBytesPerConnection: 1 << 30,
    });
    const meta = { sweptAt: 1, complete: true };
    const rows = (names: string[]) =>
      names.map((name) => queueRow({ name, vhost: '/' }));
    index.install('queues', rows(['Alpha', 'BETA']), meta);
    // Rows are estimated at 256 bytes plus two a character of the name and the vhost.
    expect(index.stats.bytes).toBe(256 + 2 * 6 + (256 + 2 * 5));
    expect(index.folded('queues')).toEqual(['alpha', 'beta']);
    // Built once and counted: the same list comes back, and the estimate grew by 8 plus two a character.
    expect(index.folded('queues')).toBe(index.folded('queues'));
    expect(index.stats.bytes).toBe(
      256 + 2 * 6 + (256 + 2 * 5) + (8 + 2 * 5) + (8 + 2 * 4),
    );
    // A new version of the kind has its own list, and the old one is no longer counted.
    index.install('queues', rows(['Gamma']), meta);
    expect(index.stats.bytes).toBe(256 + 2 * 6);
    expect(index.folded('queues')).toEqual(['gamma']);
    expect(index.stats.bytes).toBe(256 + 2 * 6 + (8 + 2 * 5));
    expect(index.folded('exchanges')).toEqual([]);
  });
});
