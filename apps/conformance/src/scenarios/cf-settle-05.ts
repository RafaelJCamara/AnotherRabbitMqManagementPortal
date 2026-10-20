// CF-SETTLE-05: a quorum message returned by the management API (`POST .../get`, `ackmode`
// `ack_requeue_true`) under every delivery limit. Counters are read from the 0-9-1 drain afterwards.
import { settleReturnScenario } from './settle-return.ts';

export const cfSettle05 = settleReturnScenario({
  cfId: 'CF-SETTLE-05',
  title:
    'Quorum queue: a message returned by the management get with ack_requeue_true under no limit, a finite limit and a limit of -1',
  returnWith: { kind: 'http' },
});
