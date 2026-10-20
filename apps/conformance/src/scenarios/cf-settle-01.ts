// CF-SETTLE-01: a quorum message returned with `basic.nack` (requeue true) under every delivery limit.
import { settleReturnScenario } from './settle-return.ts';

export const cfSettle01 = settleReturnScenario({
  cfId: 'CF-SETTLE-01',
  title:
    'Quorum queue: a message returned with basic.nack (requeue true) under no limit, a finite limit and a limit of -1',
  returnWith: { kind: 'amqp091', action: 'nack' },
});
