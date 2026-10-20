// CF-DR-01 and CF-DR-02 twice each on a real lab broker: the steps and observations of the two runs
// must be equal, so the live leg can compare with recorded evidence without flaking (OQ-632). The
// management statistics are the risk: they refresh on their own interval, so a count read at a fixed
// moment can differ between runs; the scenarios therefore record only the class of each count. This
// check is the arbiter. Run as a child process by libs/testkit/src/it/conformance.it.ts with the
// broker in LAB_BROKER; it writes nothing and claims nothing about the broker.
import assert from 'node:assert/strict';

import { runLive } from '../assert/live.ts';
import {
  parseLabBrokerData,
  verifyLabEndpoint,
} from '../driver/lab-endpoint.ts';
import { openLabHost } from '../record/record.ts';
import { cfDr01 } from '../scenarios/cf-dr-01.ts';
import { cfDr02 } from '../scenarios/cf-dr-02.ts';

const endpoint = await verifyLabEndpoint(
  parseLabBrokerData(process.env.LAB_BROKER),
);
const broker = { endpoint, open: () => openLabHost(endpoint) };
const compared = (run: Awaited<ReturnType<typeof runLive>>) => ({
  steps: run.steps,
  observations: run.observations,
});

for (const scenario of [cfDr01, cfDr02]) {
  const first = await runLive(broker, scenario);
  const second = await runLive(broker, scenario);
  assert.deepEqual(compared(second), compared(first), scenario.cfId);
}
console.log(`dr-determinism ok on ${endpoint.version}`);
