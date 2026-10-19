// bundles.import: Import the profiles of a bundle; their secrets are entered afterwards
import {
  CONNECTIONS_PER_PRINCIPAL_MAX,
  ConnectionIdSchema,
  bundlesImport,
} from '@app/contracts';
import { AppError, implementAction, type ActionImpl } from '@app/kernel';

import type { ConnectionsModuleDeps } from '../deps';
import { alwaysValid, plainPlan } from '../internal/common';
import { configOfBundleProfile } from '../internal/endpoints';

const WINDOW = 100;
const NAME_MAX = 80;

/** The ports this action uses: a subset of the module's deps (src/deps.ts). */
export type BundlesImportDeps = Pick<ConnectionsModuleDeps, 'store' | 'newId'>;

/** `Name (2)`, `Name (3)`...: the first that is free, cut so that it still fits the name limit. */
function freeName(name: string, taken: ReadonlySet<string>): string {
  for (let n = 2; ; n += 1) {
    const suffix = ` (${String(n)})`;
    const candidate = `${name.slice(0, NAME_MAX - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export const createBundlesImportAction = (
  deps: BundlesImportDeps,
): ActionImpl<typeof bundlesImport> =>
  implementAction(bundlesImport, {
    plan: (input) =>
      plainPlan({
        creates: 'connections',
        count: input.bundle.profiles.length,
      })(),
    revalidate: alwaysValid,
    execute: async (input, ctx) => {
      const owner = ctx.principal.id;
      const policy = input.onConflict ?? 'skip';

      // The names the caller already uses, in windows: a bounded read (I-7).
      const taken = new Set<string>();
      let cursor: string | undefined;
      let count = 0;
      while (count < CONNECTIONS_PER_PRINCIPAL_MAX) {
        const window = await deps.store.list({
          visibleTo: owner,
          limit: WINDOW,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const record of window.items) {
          count += 1;
          if (record.ownerId === owner) taken.add(record.name);
        }
        cursor = window.nextCursor;
        if (cursor === undefined) break;
      }

      // Decide everything first, so that a bundle that does not fit creates nothing.
      const created: { id: string; name: string }[] = [];
      const skipped: { name: string; reason: 'name-exists' }[] = [];
      const plan: {
        name: string;
        profile: (typeof input.bundle.profiles)[number];
      }[] = [];
      for (const profile of input.bundle.profiles) {
        if (taken.has(profile.name) && policy === 'skip') {
          skipped.push({ name: profile.name, reason: 'name-exists' });
          continue;
        }
        const name = taken.has(profile.name)
          ? freeName(profile.name, taken)
          : profile.name;
        taken.add(name);
        plan.push({ name, profile });
      }
      if (count + plan.length > CONNECTIONS_PER_PRINCIPAL_MAX) {
        throw new AppError('BUDGET_EXCEEDED', {
          detail: `At most ${String(CONNECTIONS_PER_PRINCIPAL_MAX)} connections can be saved.`,
        });
      }

      for (const { name, profile } of plan) {
        const id = deps.newId();
        await deps.store.save({
          id,
          name,
          envClass: profile.envClass,
          color: profile.color,
          config: configOfBundleProfile(profile),
          ownerId: owner,
          visibility: 'private',
        });
        created.push({ id, name });
      }
      return {
        created: created.map((entry) => ({
          id: ConnectionIdSchema.parse(entry.id),
          name: entry.name,
        })),
        skipped,
      };
    },
  });
