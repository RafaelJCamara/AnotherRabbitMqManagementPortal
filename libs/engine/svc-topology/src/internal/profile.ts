// The cached profile of a connection, read and parsed. The explorer only reads it (the hazard ids
// that explain a missing column); the probe writes it.
import type { ConnectionId } from '@app/contracts';
import { BrokerProfileSchema, type BrokerProfile } from '@app/domain-model';
import { AppError } from '@app/kernel';
import type { BrokerProfileStore } from '@app/ports';

export async function readProfile(
  profiles: Pick<BrokerProfileStore, 'get'>,
  cid: ConnectionId,
): Promise<BrokerProfile> {
  const record = await profiles.get(cid);
  if (record === undefined) {
    throw new AppError('NOT_FOUND', {
      detail: 'This connection has not been probed yet. Run the probe first.',
    });
  }
  const profile = BrokerProfileSchema.safeParse(record.profile);
  if (!profile.success) {
    // A profile written by another version of the engine: the cache is a copy, so ask again.
    throw new AppError('NOT_FOUND', {
      detail:
        'The cached profile of this connection is out of date. Run the probe again.',
    });
  }
  return profile.data;
}
