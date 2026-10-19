// The workspace repository port (M0-47). svc-workspace stores what the UI remembers for a person:
// saved views, the layout of each connection profile, settings and keybindings. Everything is
// owned by one principal (`ownerId`), so in the team server one person's workspace is not
// another's. Every method is async and no method lists "all" (I-7): views come in windows, and
// documents are bounded by the caller's limit.
import type { Window } from './repos.ts';

/** A saved view: filters, columns and sort of one grid. Not bound to a connection. */
export interface SavedViewRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  /** Which grid it is for (`queues`, `exchanges`...). Opaque to the engine. */
  readonly kind: string;
  /** JSON the UI owns; the contract bounds its size. */
  readonly definition: unknown;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** What is kept per owner besides views. A key names the document within its kind. */
export type WorkspaceDocumentKind = 'layout' | 'setting' | 'keybindings';

export interface WorkspaceDocument {
  readonly key: string;
  readonly value: unknown;
  readonly updatedAt: number;
}

export interface WorkspaceRepository {
  /** The owner's views in id (creation) order, optionally of one kind, after `cursor`. */
  listViews(
    ownerId: string,
    query: { kind?: string; limit: number; cursor?: string },
  ): Promise<Window<SavedViewRecord>>;
  countViews(ownerId: string): Promise<number>;
  insertView(view: SavedViewRecord): Promise<void>;
  /** True when the owner had that view. Another owner's view is never touched. */
  deleteView(ownerId: string, id: string): Promise<boolean>;

  getDocument(
    ownerId: string,
    kind: WorkspaceDocumentKind,
    key: string,
  ): Promise<WorkspaceDocument | undefined>;
  /** Inserts or replaces. */
  putDocument(
    ownerId: string,
    kind: WorkspaceDocumentKind,
    key: string,
    value: unknown,
  ): Promise<void>;
  /** The owner's documents of one kind in key order: at most `limit`. */
  listDocuments(
    ownerId: string,
    kind: WorkspaceDocumentKind,
    limit: number,
  ): Promise<readonly WorkspaceDocument[]>;
}
