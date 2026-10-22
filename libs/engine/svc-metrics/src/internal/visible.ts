// A connection is visible to its owner, and to everyone when it is shared with the team. Someone
// else's private connection is reported exactly like one that does not exist, so ids cannot be probed
// (the same rule as svc-capabilities and svc-explorer; a service may not import another, so it is
// stated here again).
import type { ConnectionId } from '@app/contracts';
import { AppError } from '@app/kernel';
import type { ConnectionStore } from '@app/ports';

export async function requireVisible(
  connections: Pick<ConnectionStore, 'get'>,
  cid: ConnectionId,
  principalId: string,
): Promise<void> {
  const record = await connections.get(cid);
  if (
    record === undefined ||
    (record.visibility !== 'team' && record.ownerId !== principalId)
  ) {
    throw new AppError('NOT_FOUND', { detail: 'There is no such connection.' });
  }
}
