// messages.publish-history.list: a keyset window of what the caller published on one connection,
// newest first (PUB-02, H4). The owner is the principal; the store never opens a sealed byte for a
// window, so the answer holds the plain facts only (exchange, key, counts, size, hash) and no
// property, header or body. A read: it leaves no audit row and no receipt.
import {
  type InputOf,
  type OutputOf,
  messagesPublishHistoryList,
} from '@app/contracts';
import { implementAction, type ActionImpl } from '@app/kernel';

import type { MessagesActionDeps } from '../deps';

/** The ports this action reads through. */
export type MessagesPublishHistoryListDeps = Pick<MessagesActionDeps, 'store'>;

export const createMessagesPublishHistoryListAction: (
  deps: MessagesPublishHistoryListDeps,
) => ActionImpl<typeof messagesPublishHistoryList> = (deps) =>
  implementAction(messagesPublishHistoryList, {
    async execute(
      input: InputOf<typeof messagesPublishHistoryList>,
      ctx,
    ): Promise<OutputOf<typeof messagesPublishHistoryList>> {
      // Absent filters stay absent: the store treats `undefined` and "not given" alike, but an empty
      // string is a real filter (the default exchange).
      const window = await deps.store.window(ctx.principal.id, {
        connectionId: input.cid,
        ...(input.vhost === undefined ? {} : { vhost: input.vhost }),
        ...(input.exchange === undefined ? {} : { exchange: input.exchange }),
        ...(input.routingKeyPrefix === undefined
          ? {}
          : { routingKeyPrefix: input.routingKeyPrefix }),
        ...(input.from === undefined ? {} : { from: input.from }),
        ...(input.to === undefined ? {} : { to: input.to }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      return {
        entries: [...window.entries],
        ...(window.nextCursor === undefined
          ? {}
          : { nextCursor: window.nextCursor }),
      };
    },
  });
