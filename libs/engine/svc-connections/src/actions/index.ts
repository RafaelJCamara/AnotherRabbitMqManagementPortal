// One implementAction per file in this directory. The action generator lists each factory here;
// the module calls every one with its ports.
import type { ActionImpl } from '@app/kernel';

import type { ConnectionsModuleDeps } from '../deps';
import { createConnectionsCreateAction } from './connections-create';
import { createConnectionsUpdateAction } from './connections-update';
import { createConnectionsDeleteAction } from './connections-delete';
import { createConnectionsListAction } from './connections-list';
import { createConnectionsGetAction } from './connections-get';
import { createConnectionsTestHttpAction } from './connections-test-http';
import { createConnectionsTestAmqpAction } from './connections-test-amqp';
import { createBundlesExportAction } from './bundles-export';
import { createBundlesImportAction } from './bundles-import';

export const actionFactories: readonly ((
  deps: ConnectionsModuleDeps,
) => ActionImpl)[] = [
  createConnectionsCreateAction,
  createConnectionsUpdateAction,
  createConnectionsDeleteAction,
  createConnectionsListAction,
  createConnectionsGetAction,
  createConnectionsTestHttpAction,
  createConnectionsTestAmqpAction,
  createBundlesExportAction,
  createBundlesImportAction,
];

export function createActions(
  deps: ConnectionsModuleDeps,
): readonly ActionImpl[] {
  return actionFactories.map((create) => create(deps));
}
