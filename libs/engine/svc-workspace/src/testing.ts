// Fakes for the ports of this module, shared by its specs, by the architecture manifest
// (tools/arch-tests) and by the HTTP specs (libs/testkit). Give each port in deps.ts a fake here.
import type {
  SavedViewRecord,
  WorkspaceDocument,
  WorkspaceDocumentKind,
  WorkspaceRepository,
} from '@app/ports';

import type { WorkspaceModuleDeps } from './deps';

/** A workspace store in memory with the semantics of the real one: owners never see each other. */
export function createMemoryWorkspaceRepository(
  options: {
    now?: () => number;
    /** Views the store starts with. */
    views?: readonly SavedViewRecord[];
  } = {},
): WorkspaceRepository {
  const now = options.now ?? Date.now;
  const views = new Map<string, SavedViewRecord>(
    (options.views ?? []).map((view) => [view.id, view]),
  );
  const documents = new Map<
    string,
    {
      ownerId: string;
      kind: WorkspaceDocumentKind;
      document: WorkspaceDocument;
    }
  >();
  const keyOf = (ownerId: string, kind: WorkspaceDocumentKind, key: string) =>
    JSON.stringify([ownerId, kind, key]);
  const documentsOf = (ownerId: string, kind: WorkspaceDocumentKind) =>
    [...documents.values()]
      .filter((entry) => entry.ownerId === ownerId && entry.kind === kind)
      .map((entry) => entry.document)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const viewsOf = (ownerId: string) =>
    [...views.values()]
      .filter((view) => view.ownerId === ownerId)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    listViews: (ownerId, query) => {
      const matching = viewsOf(ownerId).filter(
        (view) =>
          (query.kind === undefined || view.kind === query.kind) &&
          (query.cursor === undefined || view.id > query.cursor),
      );
      const items = matching.slice(0, query.limit);
      const last = items.at(-1);
      return Promise.resolve(
        matching.length > query.limit && last !== undefined
          ? { items, nextCursor: last.id }
          : { items },
      );
    },
    countViews: (ownerId) => Promise.resolve(viewsOf(ownerId).length),
    insertView: (view) => {
      views.set(view.id, view);
      return Promise.resolve();
    },
    deleteView: (ownerId, id) =>
      Promise.resolve(
        views.get(id)?.ownerId === ownerId ? views.delete(id) : false,
      ),
    getDocument: (ownerId, kind, key) =>
      Promise.resolve(documents.get(keyOf(ownerId, kind, key))?.document),
    putDocument: (ownerId, kind, key, value) => {
      documents.set(keyOf(ownerId, kind, key), {
        ownerId,
        kind,
        document: { key, value, updatedAt: now() },
      });
      return Promise.resolve();
    },
    listDocuments: (ownerId, kind, limit) =>
      Promise.resolve(documentsOf(ownerId, kind).slice(0, limit)),
  };
}

export function createWorkspaceFakeDeps(
  options: { views?: readonly SavedViewRecord[] } = {},
): WorkspaceModuleDeps {
  let next = 0;
  return {
    workspace: createMemoryWorkspaceRepository(options),
    newId: () => `view-${String((next += 1)).padStart(4, '0')}`,
  };
}
