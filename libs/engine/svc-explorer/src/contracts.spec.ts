import {
  FILTER_TEXT_MAX,
  VISIBLE_KEYS_MAX,
  WINDOW_LIMIT_MAX,
  checkRegistry,
  registry,
} from '@app/contracts';
import { createTestContext, createTestExecutor } from '@app/kernel';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createInventoryQueryAction } from './actions/inventory-query';
import { createExplorerFakeDeps } from './testing';

/** The contracts of this module; later slices add overview.get, search.query and explorer.window. */
const ids = ['inventory.query', 'overview.get', 'search.query'];
const actions = registry.actions.filter((a) => ids.includes(a.id));
const topics = registry.topics.filter((t) => t.id === 'explorer.window');
const def = actions.find((a) => a.id === 'inventory.query');
if (def === undefined) throw new Error('inventory.query is not registered');

const valid = {
  cid: 'c1',
  kind: 'queues',
  window: { offset: 0, limit: 200 },
};
const bad: Record<string, unknown> = {
  'window.limit 501': { ...valid, window: { offset: 0, limit: 501 } },
  'negative offset': { ...valid, window: { offset: -1, limit: 10 } },
  'filter.text 201 characters': {
    ...valid,
    filter: { text: 'x'.repeat(FILTER_TEXT_MAX + 1) },
  },
  '101 vhosts': {
    ...valid,
    filter: { vhosts: Array.from({ length: 101 }, (_, i) => `v${String(i)}`) },
  },
  'unknown kind': { ...valid, kind: 'channels' },
  'missing window': { cid: 'c1', kind: 'queues' },
  'unknown field': { ...valid, all: true },
};

const z_ = (schema: z.ZodType, io: 'input' | 'output') =>
  z.toJSONSchema(schema, { io, unrepresentable: 'any' });

/** Every array of a JSON schema with its `maxItems`, and the path it was found at. */
function arrays(node: unknown, path: string, out: [string, unknown][]) {
  if (Array.isArray(node)) {
    node.forEach((n, i) => {
      arrays(n, `${path}[${String(i)}]`, out);
    });
  } else if (node !== null && typeof node === 'object') {
    const schema = node as Record<string, unknown>;
    if (schema.type === 'array') out.push([path, schema.maxItems]);
    for (const [k, v] of Object.entries(schema)) arrays(v, `${path}.${k}`, out);
  }
}

describe('explorer contracts', () => {
  it('M0-48 AC-1 explorer contracts allow no unbounded input or output', async () => {
    expect(actions.map((a) => a.id)).toContain('inventory.query');
    expect(checkRegistry({ actions, topics })).toEqual([]);

    // Each bad input is refused as VALIDATION_FAILED before anything runs.
    expect(def.input.safeParse(valid).success).toBe(true);
    const engine = createTestExecutor();
    engine.executor.register(
      createInventoryQueryAction(createExplorerFakeDeps()),
    );
    for (const [name, input] of Object.entries(bad)) {
      await expect(
        engine.executor.run(def, input, createTestContext()),
        name,
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }

    // Every array of every input and output has a maximum, and none asks for or returns more than 500.
    const found: [string, unknown][] = [];
    for (const a of actions) {
      arrays(z_(a.input, 'input'), `${a.id}.input`, found);
      arrays(z_(a.output, 'output'), `${a.id}.output`, found);
    }
    for (const t of topics) {
      arrays(z_(t.params, 'input'), `${t.id}.params`, found);
      arrays(z_(t.item, 'output'), `${t.id}.item`, found);
    }
    expect(found.length).toBeGreaterThan(0);
    for (const [path, max] of found) {
      expect(max, path).toBeTypeOf('number');
      expect(max as number, path).toBeLessThanOrEqual(
        Math.max(WINDOW_LIMIT_MAX, VISIBLE_KEYS_MAX),
      );
    }
  });
});
