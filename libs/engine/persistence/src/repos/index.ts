import type { PersistenceHandle } from '../database';
import { createBlobRepository } from './blobs';
import { createConnectionProfileRepository } from './connection-profiles';
import type { Repositories } from './ports';
import { createSettingsRepository } from './settings';

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
  };
}
