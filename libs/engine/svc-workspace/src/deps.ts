import type { WorkspaceRepository } from '@app/ports';

/**
 * The ports this module needs, injected by the composition root: the repository over the engine's
 * own store, and a source of ids for new views (a ULID generator; the kernel has one).
 */
export interface WorkspaceModuleDeps {
  readonly workspace: WorkspaceRepository;
  readonly newId: () => string;
}
