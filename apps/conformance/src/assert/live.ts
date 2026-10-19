// The live leg: run a scenario against a broker broker-lab created and keep what it produced in the
// shape an artefact records. The broker is the one `conformance:test --versions=...` handed over in
// LAB_BROKER; `verifyLabEndpoint` still asks Docker whether it really is a lab broker.
import { randomBytes } from 'node:crypto';
import {
  parseLabBrokerData,
  verifyLabEndpoint,
  type LabEndpoint,
  type VerifyDeps,
} from '../driver/lab-endpoint.ts';
import { runScenario, type LabScenario } from '../dsl.ts';
import { openLabHost, type RecordHost } from '../record/record.ts';
import type { LiveRun } from './three-way.ts';

export interface LiveBroker {
  readonly endpoint: LabEndpoint;
  /** A new connection. Every live run uses its own, as the recorder does for every scenario. */
  readonly open: () => Promise<RecordHost>;
}

export interface LiveDeps extends VerifyDeps {
  readonly openHost?: (endpoint: LabEndpoint) => Promise<RecordHost>;
}

/** The broker of this run, or null when no `LAB_BROKER` was handed over (a run of the recorded legs only). */
export async function openLiveFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  deps: LiveDeps = {},
): Promise<LiveBroker | null> {
  if (env.LAB_BROKER === undefined || env.LAB_BROKER === '') return null;
  const endpoint = await verifyLabEndpoint(
    parseLabBrokerData(env.LAB_BROKER),
    deps,
  );
  return { endpoint, open: () => (deps.openHost ?? openLabHost)(endpoint) };
}

/** Runs the scenario once and returns its steps and observations with the broker's own facts. */
export async function runLive(
  broker: LiveBroker,
  scenario: LabScenario,
  runId: string = randomBytes(4).toString('hex'),
): Promise<LiveRun> {
  const host = await broker.open();
  try {
    const served = await host.brokerVersion();
    if (served !== broker.endpoint.version) {
      throw new Error(
        `the broker serves ${served ?? 'an unreadable version'}, not the ${broker.endpoint.version} the lab pinned`,
      );
    }
    const run = await runScenario(host, scenario, runId);
    return {
      cfId: scenario.cfId,
      title: scenario.title,
      protocol: scenario.protocol,
      brokerVersion: served,
      imageDigest: broker.endpoint.digest,
      steps: run.steps,
      observations: run.observations,
    };
  } finally {
    await host.close();
  }
}
