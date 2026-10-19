// The live leg of the three-way assertion on a real lab broker. Not a spec: it needs a broker, so
// `libs/testkit/src/it/conformance.it.ts` starts one and runs this file as a child process with the
// broker in LAB_BROKER (`pnpm nx run conformance:it`). It writes nothing: the "recorded evidence" is
// built in memory from a first live run, stamped as a CI run (a stand-in for the test only), and the
// second live run is compared with it. Then one recorded observation is flipped and the comparison
// must fail with the field-level diff. It claims nothing about what the broker does, only that the
// harness tells a matching run from a differing one against a real broker.
import assert from 'node:assert/strict';

import {
  verifyLabEndpoint,
  parseLabBrokerData,
} from '../driver/lab-endpoint.ts';
import { sealArtefact } from '../record/evidence.ts';
import { openLabHost } from '../record/record.ts';
import { runLive } from '../assert/live.ts';
import { evaluate, type EvaluateInput } from '../assert/three-way.ts';
import { cfSmoke01 } from '../scenarios/cf-smoke-01.ts';

const endpoint = await verifyLabEndpoint(
  parseLabBrokerData(process.env.LAB_BROKER),
);
const broker = { endpoint, open: () => openLabHost(endpoint) };
const first = await runLive(broker, cfSmoke01);
const stamp = {
  kind: 'ci',
  recorder: 'conformance:record',
  gitSha: 'a'.repeat(40),
  runUrl: 'https://github.com/example/example/actions/runs/1/attempts/1',
  workflow:
    'example/example/.github/workflows/conformance-record.yml@refs/heads/main',
  recordedAt: new Date().toISOString(),
} as const;
const seal = (flip: boolean): string =>
  JSON.stringify(
    sealArtefact({
      schemaVersion: 1,
      cfId: first.cfId,
      title: first.title,
      protocol: 'amqp091',
      brokerVersion: first.brokerVersion,
      imageDigest: first.imageDigest,
      steps: [...first.steps],
      observations: first.observations.map((item) =>
        flip && item.messageId === 'm1'
          ? { ...item, redelivered: item.redelivered !== true }
          : item,
      ),
      provenance: stamp,
    }),
  );
const path = `${first.brokerVersion}/${first.cfId}.json`;
const base = (
  text: string,
  live: Awaited<ReturnType<typeof runLive>>,
): EvaluateInput => ({
  cfId: first.cfId,
  version: first.brokerVersion,
  era: 'lab',
  pin: endpoint.digest,
  cells: [],
  file: { kind: 'present', path, text },
  live,
  projection: undefined,
});

const [same] = evaluate(base(seal(false), await runLive(broker, cfSmoke01)));
assert.ok(same);
assert.equal(same.live.state, 'match');
assert.equal(same.evidence.state, 'valid');

const [differs] = evaluate(base(seal(true), await runLive(broker, cfSmoke01)));
assert.ok(differs);
assert.equal(differs.verdict, 'fail');
assert.equal(differs.live.state, 'mismatch');
assert.deepEqual(
  differs.live.diffs.map((diff) => diff.path),
  ['$.observations[0].redelivered'],
);
console.log(`three-way-smoke ok on ${first.brokerVersion}`);
