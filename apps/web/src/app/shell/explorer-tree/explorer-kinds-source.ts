// The explorer tree of a connection (M0-54, R11, Q-18): the overview and the four kinds of inventory, as a
// static list. It makes no engine call and shows no count and no vhost level: opening the shell costs the broker
// nothing, and the explorer feature loads only when one of these nodes is opened. The labels are translated; a
// node's address is `/c/<cid>/explorer[/<kind>]`, which passes the shell's tab-address check.
import {
  computed,
  inject,
  signal,
  type Provider,
  type Signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { TranslocoService } from '@jsverse/transloco';
import { combineLatest } from 'rxjs';

import { SCOPE_LOADERS, scopeDefinition } from '../../i18n/i18n.config';
import {
  EXPLORER_TREE_SOURCE,
  type ExplorerNode,
  type ExplorerTreeSource,
} from './explorer-tree-source';

/** The nodes, in the order the tree draws them; `overview` is the explorer's own address. */
export const EXPLORER_KIND_NODES = [
  'overview',
  'queues',
  'exchanges',
  'connections',
  'bindings',
] as const;

const NO_NODES: Signal<readonly ExplorerNode[]> = signal<
  readonly ExplorerNode[]
>([]).asReadonly();

/**
 * The static source. `labels` holds the translated labels in node order, or `null` until they are loaded
 * (the tree then draws nothing instead of untranslated words). One signal of nodes per connection.
 */
export function explorerKindsSource(
  labels: Signal<readonly string[] | null>,
): ExplorerTreeSource {
  const byConnection = new Map<string, Signal<readonly ExplorerNode[]>>();
  return {
    roots: (cid) => {
      let roots = byConnection.get(cid);
      if (roots === undefined) {
        roots = computed((): readonly ExplorerNode[] => {
          const words = labels();
          if (words === null) return [];
          return EXPLORER_KIND_NODES.map(
            (kind, index): ExplorerNode => ({
              id: `explorer:${kind}`,
              label: words[index] ?? kind,
              url:
                kind === 'overview'
                  ? `/c/${cid}/explorer`
                  : `/c/${cid}/explorer/${kind}`,
              children: 'none',
            }),
          );
        });
        byConnection.set(cid, roots);
      }
      return roots;
    },
    children: () => NO_NODES,
  };
}

/** Provides the source with its labels from the `shell` scope (`shell.tree.kind.*`). */
export function provideExplorerKindsSource(): Provider {
  return {
    provide: EXPLORER_TREE_SOURCE,
    useFactory: (): ExplorerTreeSource => {
      const transloco = inject(TranslocoService);
      const scope = scopeDefinition(inject(SCOPE_LOADERS), 'shell');
      const labels = toSignal(
        combineLatest(
          EXPLORER_KIND_NODES.map((kind) =>
            transloco.selectTranslate<string>(`tree.kind.${kind}`, {}, scope),
          ),
        ),
        { initialValue: null },
      );
      return explorerKindsSource(labels);
    },
  };
}
