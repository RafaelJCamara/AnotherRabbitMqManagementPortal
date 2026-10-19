// CF-SMOKE-01: a classic queue, `basic.get`, then `basic.nack` with requeue. The first get hands out
// the head message as not redelivered; after the nack the same message must come back first and
// flagged as redelivered (position 0 of the drain), with its neighbour behind it. This is the
// smallest scenario that exercises the whole recorder: declare, publish, get, settle, observe.
import {
  declareQueue,
  defineScenario,
  get,
  observe,
  publish,
  settle,
} from '../dsl.ts';

export const cfSmoke01 = defineScenario({
  cfId: 'CF-SMOKE-01',
  title:
    'Classic queue: basic.get then basic.nack with requeue returns the message first, redelivered',
  protocol: 'amqp091',
  steps: [
    declareQueue('q', { type: 'classic' }),
    publish('q', 'm1'),
    publish('q', 'm2'),
    get('first', 'q'),
    settle('first', { kind: 'nack', requeue: true }),
    observe('after-nack-requeue', 'q'),
  ],
});
