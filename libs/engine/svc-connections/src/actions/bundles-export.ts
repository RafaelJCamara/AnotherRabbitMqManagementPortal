// bundles.export: Export connection profiles as a bundle without any secret
import {
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  CONNECTIONS_PER_PRINCIPAL_MAX,
  bundlesExport,
  type ConnectionBundle,
} from '@app/contracts';
import { AppError, implementAction, type ActionImpl } from '@app/kernel';
import type { ConnectionRecord } from '@app/ports';

import type { ConnectionsModuleDeps } from '../deps';
import { findSecretsInBundle } from '../internal/bundle';
import { loadVisible } from '../internal/common';
import { toBundleProfile } from '../internal/endpoints';

const WINDOW = 100;

/** The ports this action reads through: a subset of the module's deps (src/deps.ts). */
export type BundlesExportDeps = Pick<ConnectionsModuleDeps, 'store'>;

export const createBundlesExportAction = (
  deps: BundlesExportDeps,
): ActionImpl<typeof bundlesExport> =>
  implementAction(bundlesExport, {
    execute: async (input, ctx) => {
      const owner = ctx.principal.id;
      const records: ConnectionRecord[] = [];
      if (input.connectionIds !== undefined) {
        // An id the caller cannot see is NOT_FOUND, like any other read of it.
        for (const id of new Set(input.connectionIds)) {
          records.push(await loadVisible(deps.store, id, owner));
        }
      } else {
        let cursor: string | undefined;
        while (records.length < CONNECTIONS_PER_PRINCIPAL_MAX) {
          const window = await deps.store.list({
            visibleTo: owner,
            limit: WINDOW,
            ...(cursor === undefined ? {} : { cursor }),
          });
          records.push(...window.items);
          cursor = window.nextCursor;
          if (cursor === undefined) break;
        }
      }
      // Only addresses and user names are read from a record: a secret is never loaded here.
      const bundle: ConnectionBundle = {
        format: BUNDLE_FORMAT,
        version: BUNDLE_VERSION,
        exportedAt: ctx.now(),
        secretsIncluded: false,
        profiles: records
          .slice(0, CONNECTIONS_PER_PRINCIPAL_MAX)
          .map(toBundleProfile),
      };
      // The last check: a bundle that holds anything secret-shaped is an engine fault, not an export.
      if (findSecretsInBundle(bundle).length > 0) {
        throw new AppError('INTERNAL', {
          detail: 'The bundle would contain a secret, so it was not exported.',
        });
      }
      return { bundle };
    },
  });
