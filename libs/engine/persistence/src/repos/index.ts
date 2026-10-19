import type { PersistenceHandle } from '../database';
import { createAuditRepository, createReceiptRepository } from './audit';
import { createBlobRepository } from './blobs';
import { createConnectionProfileRepository } from './connection-profiles';
import { createDataKeyRepository } from './data-keys';
import { createJobStore } from './jobs';
import { createIdempotencyRepository, createPlanRepository } from './plans';
import type { Repositories } from './ports';
import { createSettingsRepository } from './settings';
import { createWorkspaceRepository } from './workspace';

export interface RepositoryOptions {
  /** Wall-clock milliseconds. Defaults to `Date.now`. */
  now?: () => number;
}

/** The repositories over an open database, whichever dialect it is. */
export function createRepositories(
  handle: PersistenceHandle,
  options: RepositoryOptions = {},
): Repositories {
  const now = options.now ?? Date.now;
  return {
    settings: createSettingsRepository(handle.db, now),
    connectionProfiles: createConnectionProfileRepository(handle.db, now),
    blobs: createBlobRepository(handle.db, now),
    plans: createPlanRepository(handle.db),
    idempotency: createIdempotencyRepository(handle.db),
    audit: createAuditRepository(handle.db),
    receipts: createReceiptRepository(handle.db),
    dataKeys: createDataKeyRepository(handle.db),
    jobs: createJobStore(handle.db, handle.dialect),
    workspace: createWorkspaceRepository(handle.db, now),
  };
}
