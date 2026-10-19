// `conformance:record` for one broker: run each scenario against it, build the artefacts (nothing
// from the semantics registry goes in or comes out: the recorder is independent of it, ADR-007),
// check them for secrets, seal them and write them. All artefacts of a run are built before the
// first file is written, so a failing scenario leaves nothing half recorded.
import { Amqp091Raw, type RawDeps } from '../driver/amqp091-raw.ts';
import { httpRaw } from '../driver/http-raw.ts';
import type { LabEndpoint } from '../driver/lab-endpoint.ts';
import { runScenario, type LabScenario, type ScenarioHost } from '../dsl.ts';
import {
  EvidenceError,
  sealArtefact,
  type EvidenceArtefact,
  type EvidenceProvenance,
} from './evidence.ts';
import { findSecrets } from './secrets.ts';
import { writeEvidence } from './write.ts';

/** A broker connection with the one extra fact the recorder checks first: the version it serves. */
export interface RecordHost extends ScenarioHost {
  brokerVersion(): Promise<string | null>;
  close(): Promise<void>;
}

/** The real host: raw AMQP 0-9-1 and raw management HTTP against an endpoint broker-lab created. */
export async function openLabHost(
  endpoint: LabEndpoint,
  deps: RawDeps = {},
): Promise<RecordHost> {
  // Amqp091Raw.open and httpRaw each refuse an endpoint broker-lab did not create.
  const raw = await Amqp091Raw.open(endpoint, deps);
  return {
    openChannel: (name) => raw.openChannel(name),
    closeChannel: (name) => raw.closeChannel(name),
    declareQueue: (queue, options) => raw.declareQueue(queue, options),
    deleteQueue: (queue) => raw.deleteQueue(queue),
    publish: (queue, message) => raw.publish(queue, message),
    get: (channel, queue, noAck) => raw.get(channel, queue, noAck),
    consume: (channel, queue, count) => raw.consume(channel, queue, count),
    settle: (channel, tag, action) => raw.settle(channel, tag, action),
    recover: (channel) => raw.recover(channel),
    management: (call) => httpRaw(endpoint, call),
    async brokerVersion() {
      const { status, json } = await httpRaw(endpoint, {
        method: 'GET',
        path: '/api/overview',
      });
      const served = (json as { rabbitmq_version?: unknown } | undefined)
        ?.rabbitmq_version;
      if (status !== 200 || typeof served !== 'string') return null;
      // The two answers (HTTP and the AMQP connection properties) must agree.
      return raw.serverVersion() === null || raw.serverVersion() === served
        ? served
        : null;
    },
    close: () => raw.close(),
  };
}

export interface RecordOptions {
  readonly scenarios: readonly LabScenario[];
  readonly endpoint: LabEndpoint;
  readonly provenance: EvidenceProvenance;
  /** Where the artefacts go (`<root>/<version>/<CF-id>.json`). */
  readonly root: string;
  /** The repository's `testing/lab-evidence`, which only a `ci` run may write into. */
  readonly canonicalRoot: string;
  readonly runId: string;
  readonly openHost?: (endpoint: LabEndpoint) => Promise<RecordHost>;
}

/**
 * Records every scenario against the endpoint's broker and returns the files written. Each scenario
 * gets its own connection: delivery tags count per channel, and a scenario may break its channel on
 * purpose, so what one scenario recorded must not depend on the ones that ran before it (the live leg
 * of the three-way assertion replays a scenario alone on a fresh connection and compares).
 */
export async function recordCells(options: RecordOptions): Promise<string[]> {
  const { endpoint } = options;
  const open = options.openHost ?? openLabHost;
  const knownSecrets = [endpoint.credentials.password];
  const artefacts: EvidenceArtefact[] = [];
  for (const scenario of options.scenarios) {
    const host = await open(endpoint);
    try {
      const served = await host.brokerVersion();
      if (served !== endpoint.version) {
        throw new EvidenceError(
          'refused',
          `the broker serves ${served ?? 'an unreadable version'}, not the ${endpoint.version} the lab pinned`,
        );
      }
      const run = await runScenario(host, scenario, options.runId);
      const artefact = sealArtefact({
        schemaVersion: 1,
        cfId: scenario.cfId,
        title: scenario.title,
        protocol: scenario.protocol,
        brokerVersion: served,
        imageDigest: endpoint.digest,
        steps: run.steps,
        observations: run.observations,
        provenance: options.provenance,
      });
      const findings = findSecrets(artefact, knownSecrets);
      if (findings.length > 0) {
        throw new EvidenceError(
          'secret',
          `${scenario.cfId} would record ${findings.map((item) => `${item.reason} at ${item.path}`).join('; ')}`,
        );
      }
      artefacts.push(artefact);
    } finally {
      await host.close();
    }
  }
  return artefacts.map((artefact) =>
    writeEvidence(artefact, {
      root: options.root,
      canonicalRoot: options.canonicalRoot,
      knownSecrets,
    }),
  );
}
