// search.query: Search the names of the inventory of a connection
// The names are searched in the engine-resident index and never at the broker (I-7, I-8): the
// answer holds the best SEARCH_RESULT_MAX names with the count of all matches, and says how fresh
// and how complete the index was (I-13). Like inventory.query it starts the sweeps of a cold
// connection and answers at once from what has been installed, labelled `loading`.
import {
  SEARCH_KINDS,
  SEARCH_RESULT_MAX,
  searchQuery,
  type SearchKind,
} from '@app/contracts';
import { implementAction, type ActionImpl } from '@app/kernel';

import type { ExplorerModuleDeps } from '../deps';
import { describeFreshness, UNAVAILABLE_VERSION } from '../internal/freshness';
import { readProfile } from '../internal/profile';
import { mergeFreshness, searchNames } from '../internal/search';
import type { Sweeper } from '../internal/sweeper';
import { requireVisible } from '../internal/visible';

/** The ports this action reads through: a subset of the module's deps (src/deps.ts) and the sweeper. */
export type SearchQueryDeps = Pick<
  ExplorerModuleDeps,
  'connections' | 'profiles'
> & { readonly sweeper: Pick<Sweeper, 'touch' | 'index' | 'status'> };

export const createSearchQueryAction: (
  deps: SearchQueryDeps,
) => ActionImpl<typeof searchQuery> = (deps) =>
  implementAction(searchQuery, {
    execute: async (input, ctx) => {
      const { cid, text } = input;
      await requireVisible(deps.connections, cid, ctx.principal.id);
      const profile = await readProfile(deps.profiles, cid);
      // Each kind once, in the contract's order, whatever order the caller named them in.
      const asked = new Set<SearchKind>(input.kinds ?? SEARCH_KINDS);
      const kinds = SEARCH_KINDS.filter((kind) => asked.has(kind));

      deps.sweeper.touch(cid);
      const index = deps.sweeper.index(cid);
      const status = deps.sweeper.status(cid);
      const version = index?.current() ?? UNAVAILABLE_VERSION;
      const sources = kinds.map((kind) => ({
        kind,
        rows: index?.rows(kind) ?? [],
      }));
      const { hits, matched } = searchNames(sources, text, SEARCH_RESULT_MAX);
      const [first, ...others] = kinds.map((kind, i) =>
        describeFreshness({
          kind,
          installed: index?.has(kind) ?? false,
          version,
          loaded: sources[i]?.rows.length ?? 0,
          expected: status.expected.get(kind),
          sweeping: status.sweeping,
          profileHazards: profile.hazards,
          versionChanged: false,
        }),
      );
      if (first === undefined) throw new Error('A search covers one kind.');
      return {
        results: hits.map(({ kind, row, rank }) => ({
          kind,
          key: row.key,
          vhost: row.vhost,
          name: row.name,
          rank,
        })),
        matched,
        truncated: matched > hits.length,
        freshness: mergeFreshness(first, ...others),
      };
    },
  });
