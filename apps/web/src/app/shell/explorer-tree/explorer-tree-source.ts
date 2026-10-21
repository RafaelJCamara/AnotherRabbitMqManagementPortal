// Where the explorer tree gets its nodes. The tree knows nothing about queues or exchanges: a
// source hands it nodes, a feature that has data (M0-48, M0-54) provides a source, and until then
// the default source holds the connection's own root node (OQ-536). A source returns windows, not
// whole inventories (I-7): the tree draws at most `EXPLORER_TREE_ROW_LIMIT` rows and says so.
import { InjectionToken, signal, type Signal } from '@angular/core';

export interface ExplorerNode {
  readonly id: string;
  /** Engine data, rendered as text only. */
  readonly label: string;
  /** Router URL under `/c/<cid>/` to open when the node is activated; null for a folder. */
  readonly url: string | null;
  /** `none`: a leaf. `lazy`: has children that are not loaded yet. `loaded`: has children. */
  readonly children: 'none' | 'lazy' | 'loaded';
}

export interface ExplorerTreeSource {
  /** The top level of the tree for a connection. */
  roots(cid: string): Signal<readonly ExplorerNode[]>;
  /** The children of a node; asking for them is what loads a `lazy` node. */
  children(id: string): Signal<readonly ExplorerNode[]>;
}

/** The most rows the tree draws, expanded nodes included. */
export const EXPLORER_TREE_ROW_LIMIT = 500;

const NO_NODES: Signal<readonly ExplorerNode[]> = signal<
  readonly ExplorerNode[]
>([]).asReadonly();

/** The default source: one node, the connection itself, which opens the explorer. */
export function connectionRootSource(): ExplorerTreeSource {
  let cached: { cid: string; roots: Signal<readonly ExplorerNode[]> } | null =
    null;
  return {
    roots: (cid) => {
      if (cached?.cid !== cid) {
        cached = {
          cid,
          roots: signal<readonly ExplorerNode[]>([
            {
              id: `connection:${cid}`,
              label: cid,
              url: `/c/${cid}/explorer`,
              children: 'none',
            },
          ]).asReadonly(),
        };
      }
      return cached.roots;
    },
    children: () => NO_NODES,
  };
}

export const EXPLORER_TREE_SOURCE = new InjectionToken<ExplorerTreeSource>(
  'EXPLORER_TREE_SOURCE',
  { factory: () => connectionRootSource() },
);
