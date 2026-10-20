// CF-SETTLE-02: a quorum message returned with `basic.reject` (requeue true) under every delivery limit.
import { settleReturnScenario } from './settle-return.ts';

export const cfSettle02 = settleReturnScenario({
  cfId: 'CF-SETTLE-02',
  title:
    'Quorum queue: a message returned with basic.reject (requeue true) under no limit, a finite limit and a limit of -1',
  returnWith: { kind: 'amqp091', action: 'reject' },
});
