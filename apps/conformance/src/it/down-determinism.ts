// CF-DOWN-01 twice on a real lab broker: the steps and observations of the two runs must be equal (the
// scenario waits on the broker's ready count, never on a clock), so the live leg can compare with
// recorded evidence without flaking. Run as a child process by libs/testkit/src/it/conformance.it.ts
// with the broker in LAB_BROKER; it writes nothing and claims nothing about the broker.
import assert from 'node:assert/strict';

import { runLive } from '../assert/live.ts';
import {
  parseLabBrokerData,
  verifyLabEndpoint,
} from '../driver/lab-endpoint.ts';
import { openLabHost } from '../record/record.ts';
import { cfDown01 } from '../scenarios/cf-down-01.ts';

const endpoint = await verifyLabEndpoint(
  parseLabBrokerData(process.env.LAB_BROKER),
);
const broker = { endpoint, open: () => openLabHost(endpoint) };
const compared = (run: Awaited<ReturnType<typeof runLive>>) => ({
  steps: run.steps,
  observations: run.observations,
});

const first = await runLive(broker, cfDown01);
const second = await runLive(broker, cfDown01);
assert.deepEqual(compared(second), compared(first));
console.log(`down-determinism ok on ${first.brokerVersion}`);
