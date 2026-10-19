// What the raw drivers do on a real lab broker. Not a spec: it needs a broker, so
// `libs/testkit/src/it/conformance.it.ts` starts one and runs this file as a child process with the
// broker in LAB_BROKER (`pnpm nx run conformance:it`). It writes nothing, and it asserts only what
// the drivers must do whatever the broker version: report a closed channel with the broker's reply
// code, settle with every AMQP 1.0 outcome, and read the management API. What the broker does about
// each settle is evidence for the lab to record, not something this file claims.
import assert from 'node:assert/strict';

import { Amqp091Raw } from '../driver/amqp091-raw.ts';
import { Amqp10Raw } from '../driver/amqp10-raw.ts';
import { httpRaw } from '../driver/http-raw.ts';
import {
  parseLabBrokerData,
  verifyLabEndpoint,
} from '../driver/lab-endpoint.ts';

const endpoint = await verifyLabEndpoint(
  parseLabBrokerData(process.env.LAB_BROKER),
);
const raw = await Amqp091Raw.open(endpoint);
const queue = `drivers-smoke-${String(process.pid)}`;
const queue10 = `drivers-smoke-10-${String(process.pid)}`;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** `basic.get` until the message shows up (a settle is asynchronous on AMQP 1.0). */
async function getWithin(name: string, ms: number) {
  const deadline = Date.now() + ms;
  for (;;) {
    const delivery = await raw.get('watch', name, true);
    if (delivery !== null || Date.now() > deadline) return delivery;
    await sleep(100);
  }
}

try {
  // The management API answers, and says which version this is.
  const overview = await httpRaw(endpoint, {
    method: 'GET',
    path: '/api/overview',
  });
  assert.equal(overview.status, 200);
  assert.equal(
    (overview.json as { rabbitmq_version: string }).rabbitmq_version,
    endpoint.version,
  );
  assert.equal(raw.serverVersion(), endpoint.version);

  // 0-9-1: the forbidden settles are reported, with the broker's reply code and text.
  await raw.declareQueue(queue, {
    type: 'classic',
    durable: true,
    arguments: {},
  });
  await raw.publish(queue, { messageId: 'm1', body: Buffer.from('one') });
  await raw.publish(queue, { messageId: 'm2', body: Buffer.from('two') });
  await raw.openChannel('bad');
  await raw.openChannel('watch');
  const first = await raw.get('main', queue, false);
  assert.ok(first !== null);
  assert.deepEqual(await raw.settle('main', first.tag, { kind: 'ack' }), {
    channelOpen: true,
  });
  const twice = await raw.settle('main', first.tag, { kind: 'ack' });
  assert.ok(!twice.channelOpen);
  assert.equal(twice.closed.code, 406);
  assert.match(twice.closed.text, /unknown delivery tag/);
  const unknown = await raw.settle('bad', 999, { kind: 'nack', requeue: true });
  assert.ok(!unknown.channelOpen);
  assert.equal(unknown.closed.code, 406);

  // 1.0: every outcome, credit granted by hand, a second settle sent and reported.
  const raw10 = await Amqp10Raw.open(endpoint);
  try {
    await raw.declareQueue(queue10, {
      type: 'classic',
      durable: true,
      arguments: {},
    });
    const target = `/queues/${queue10}`;
    assert.equal(await raw10.send(target, 'a1', 'hello'), 'accepted');
    raw10.openReceiver('r', target);
    raw10.addCredit('r', 1);
    const [received] = await raw10.receive('r', 1);
    assert.ok(received !== undefined);
    assert.equal(received.messageId, 'a1');
    assert.deepEqual(await raw10.settle(received, { kind: 'release' }), {
      again: false,
    });
    assert.deepEqual(await raw10.settle(received, { kind: 'accept' }), {
      again: true,
    });
    // A released message is back in the queue, flagged as delivered before.
    const back = await getWithin(queue10, 10_000);
    assert.ok(back !== null, 'a released message returns to the queue');
    assert.deepEqual(raw10.errors, []);
  } finally {
    await raw10.close();
  }
  console.log(`drivers-smoke ok on ${endpoint.version}`);
} finally {
  await raw.deleteQueue(queue).catch(() => undefined);
  await raw.deleteQueue(queue10).catch(() => undefined);
  await raw.close();
}
process.exit(0);
