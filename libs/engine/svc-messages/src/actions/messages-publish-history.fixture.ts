// A real history store over the repository and sealer in memory, with a way to record entries into
// it: what the two history actions read. Shared by their fixtures and specs.
import { createLogger, createManualClock } from '@app/kernel';

import type { PublishRecord } from '../deps';
import { createPublishHistory } from '../internal/publish-history';
import { createFakeSealer, createMemoryPublishHistory } from '../testing';

/** The time the fixture clock starts at (ms). */
export const T0 = 1_700_000_000_000;

export const ONE_CONFIRMED = {
  confirmed: 1,
  nacked: 0,
  returned: 0,
  blocked: 0,
  timeout: 0,
  failed: 0,
  'not-sent': 0,
} as const;

export function createHistoryFixture() {
  const clock = createManualClock(T0);
  const history = createMemoryPublishHistory();
  let n = 0;
  const store = createPublishHistory({
    history,
    sealer: createFakeSealer(),
    newId: () => {
      n += 1;
      return `entry-${String(n)}`;
    },
    clock,
    logger: createLogger({ level: 'silent' }),
  });
  /** Records one publish as `user-1` on `c1` at the fixture time unless `over` says otherwise. */
  const record = (over: Partial<PublishRecord> = {}): Promise<string> =>
    store.record({
      ownerId: 'user-1',
      connectionId: 'c1',
      vhost: '/',
      at: clock.now(),
      exchange: '',
      routingKey: 'orders',
      copies: 1,
      summary: ONE_CONFIRMED,
      props: { contentType: 'text/plain' },
      body: new TextEncoder().encode('hello'),
      ...over,
    });
  return { clock, history, store, record };
}
