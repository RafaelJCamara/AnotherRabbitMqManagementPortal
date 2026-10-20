// CF-DOWN-01: what does a quorum queue do to a message whose holder goes away gracefully?
//
// A holder connection takes a delivery of `m1` and closes its channel; the observing connection
// (`main`) outlives it, waits until the ready count is steady and drains the queue. The close is made
// after three ways of holding: `get`, `active` (a consumer left active) and `cancelled` (the consumer
// cancelled first). Queues, one per case, because the drain consumes the queue:
//   <limit>-<path>   one hold and one close, for no limit, a limit of 2 (`fin`) and -1 (`minus1`)
//   fin-<path>-x     three hold-and-close rounds on a limit of 2: does the return that crosses it drop m1?
//   fin-conn         a consumer left active on a connection of its own, closed with `connection.close`
// Message ids are fixed short words; no body, header or login is recorded.
import {
  awaitReady,
  closeChannel,
  closeConnection,
  consume,
  declareQueue,
  defineScenario,
  get,
  observe,
  openChannel,
  openConnection,
  publish,
  type LabStep,
} from '../dsl.ts';

type Path = 'get' | 'active' | 'cancelled';
const PATHS: readonly Path[] = ['get', 'active', 'cancelled'];
const LIMITS: Readonly<Record<string, Record<string, number>>> = {
  unset: {},
  fin: { 'x-delivery-limit': 2 },
  minus1: { 'x-delivery-limit': -1 },
};

/** Holds one delivery on `channel`: a `get`, or a consumer that is left active or cancelled. */
const hold = (path: Path, queue: string, channel: string, as: string) =>
  path === 'get'
    ? get(as, queue, { channel })
    : consume(as, queue, 1, { channel, cancel: path === 'cancelled' });

const prepare = (queue: string, limit: string): LabStep[] => [
  declareQueue(queue, { type: 'quorum', arguments: { ...LIMITS[limit] } }),
  publish(queue, `${queue}-m1`),
  publish(queue, `${queue}-m2`),
];

/** One hold on a channel of `holder`, then the graceful close of that channel. */
const round = (path: Path, queue: string, n: string): LabStep[] => [
  openChannel(`${queue}-ch${n}`, { connection: 'holder' }),
  hold(
    path,
    queue,
    `${queue}-ch${n}`,
    `${queue}-${n === '' ? 'held' : `r${n}`}`,
  ),
  closeChannel(`${queue}-ch${n}`),
  awaitReady(queue),
];

export const cfDown01 = defineScenario({
  cfId: 'CF-DOWN-01',
  title:
    'Quorum queue: a delivery held by a get, an active consumer or a cancelled consumer, then the channel (or the connection) closes gracefully',
  protocol: 'amqp091',
  steps: [
    openConnection('holder'),
    ...Object.keys(LIMITS).flatMap((limit) =>
      PATHS.flatMap((path) => {
        const queue = `${limit}-${path}`;
        return [
          ...prepare(queue, limit),
          ...round(path, queue, ''),
          observe(`${queue}-after`, queue),
        ];
      }),
    ),
    ...PATHS.flatMap((path) => {
      const queue = `fin-${path}-x`;
      return [
        ...prepare(queue, 'fin'),
        ...['1', '2', '3'].flatMap((n) => round(path, queue, n)),
        observe(`${queue}-after`, queue),
      ];
    }),
    ...prepare('fin-conn', 'fin'),
    openConnection('doomed'),
    openChannel('fin-conn-ch', { connection: 'doomed' }),
    consume('fin-conn-held', 'fin-conn', 1, {
      channel: 'fin-conn-ch',
      cancel: false,
    }),
    closeConnection('doomed'),
    awaitReady('fin-conn'),
    observe('fin-conn-after', 'fin-conn'),
  ],
});
