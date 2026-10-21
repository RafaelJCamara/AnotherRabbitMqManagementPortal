import { ConnectionIdSchema } from '@app/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createScriptedBroker, FAKE_CONNECTION_ID } from './testing';

const Page = z.object({
  items: z.array(z.object({ name: z.string(), vhost: z.string() })),
  page: z.number(),
  page_count: z.number(),
  total_count: z.number(),
});

describe('scripted broker', () => {
  it('serves queues across vhosts in pages of at most 500 and records every request', async () => {
    const broker = createScriptedBroker({ queueCount: 1_200, vhostCount: 3 });
    const get = (page: number, page_size: number) =>
      broker.read.get(
        {
          connectionId: ConnectionIdSchema.parse(FAKE_CONNECTION_ID),
          path: '/api/queues',
          query: { page, page_size },
          schema: Page,
          lane: 'background',
        },
        new AbortController().signal,
      );

    const pages = [await get(1, 1_000), await get(2, 500), await get(3, 500)];

    expect(pages.map((p) => p.items.length)).toEqual([500, 500, 200]);
    expect(pages[0]?.page_count).toBe(3);
    expect(new Set(pages.flatMap((p) => p.items.map((q) => q.vhost)))).toEqual(
      new Set(broker.vhosts),
    );
    expect(broker.requests).toHaveLength(3);
    expect(broker.requests[0]).toMatchObject({
      path: '/api/queues',
      lane: 'background',
    });
  });
});
