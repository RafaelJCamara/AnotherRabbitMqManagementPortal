// One implementAction per file in this directory. The action generator lists each factory here;
// the module calls every one with its ports.
import type { ActionImpl } from '@app/kernel';

import type { MessagesActionDeps } from '../deps';
import { createMessagesPublishAction } from './messages-publish';
import { createMessagesPublishHistoryGetAction } from './messages-publish-history-get';
import { createMessagesPublishHistoryListAction } from './messages-publish-history-list';

export const actionFactories: readonly ((
  deps: MessagesActionDeps,
) => ActionImpl)[] = [
  createMessagesPublishAction,
  createMessagesPublishHistoryListAction,
  createMessagesPublishHistoryGetAction,
];

export function createActions(deps: MessagesActionDeps): readonly ActionImpl[] {
  return actionFactories.map((create) => create(deps));
}
