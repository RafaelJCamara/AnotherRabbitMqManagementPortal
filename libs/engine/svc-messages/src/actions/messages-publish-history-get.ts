// messages.publish-history.get: one publish of the caller and what is needed to send it again, with
// every secret the mask recognised replaced (PUB-02, H3, H4). The owner is the principal and the
// connection is the one asked for: an entry of another owner, of another connection, an expired one
// and an unknown id all answer NOT_FOUND with one text. A read: no audit row, no receipt.
import {
  type InputOf,
  type OutputOf,
  messagesPublishHistoryGet,
} from '@app/contracts';
import { implementAction, type ActionImpl } from '@app/kernel';

import type { MessagesActionDeps } from '../deps';

/** The ports this action reads through. */
export type MessagesPublishHistoryGetDeps = Pick<MessagesActionDeps, 'store'>;

type Output = OutputOf<typeof messagesPublishHistoryGet>;

export const createMessagesPublishHistoryGetAction: (
  deps: MessagesPublishHistoryGetDeps,
) => ActionImpl<typeof messagesPublishHistoryGet> = (deps) =>
  implementAction(messagesPublishHistoryGet, {
    async execute(
      input: InputOf<typeof messagesPublishHistoryGet>,
      ctx,
    ): Promise<Output> {
      const found = await deps.store.get(
        ctx.principal.id,
        input.cid,
        input.entryId,
      );
      // The store's document is typed loosely (its header values are `{ t, v }` pairs). The executor
      // checks the answer against the contract before it leaves the engine.
      return { entry: found.entry, resend: found.resend as Output['resend'] };
    },
  });
