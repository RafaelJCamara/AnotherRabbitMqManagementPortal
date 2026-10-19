// The one door to a broker: a `LabEndpoint` exists only for a broker that testing/broker-lab
// created, and every raw driver refuses anything else (AC-2). The recorder is meant to stay away
// from a real broker however a scenario is written or a URL is configured.
//
// A broker is handed over as data (`LAB_BROKER`, the same way the contract suite gets its broker,
// OQ-187), so this project does not import the testkit. Instead of trusting the data, it asks the
// Docker daemon what is really running: a container named and labelled by broker-lab, built from
// the lab image of that version, with the AMQP and management ports published on the loopback
// address at exactly the ports the data names, and the image digest equal to the pin in
// `testing/broker-lab/versions.json`. An endpoint object is then minted here and remembered; an
// object made any other way, or a copy with another port, is not in the set.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const VERSIONS_FILE = new URL(
  '../../../../testing/broker-lab/versions.json',
  import.meta.url,
);

/** The label every lab container carries (`RUN_LABEL` of the testkit). */
const RUN_LABEL = 'io.broker-lab.run';
const VERSION_LABEL = 'io.broker-lab.rabbitmq-version';
const LOOPBACK = '127.0.0.1';
const CONTAINER = /^broker-lab-(\d+\.\d+\.\d+)-([0-9a-f]{8})$/;

export class ForeignEndpointError extends Error {
  constructor(reason: string) {
    super(`refusing to talk to this broker: ${reason}`);
    this.name = 'ForeignEndpointError';
  }
}

/** What the lab launcher hands over for one running broker. */
const brokerData = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    amqp: z.string(),
    http: z.string(),
    container: z.string(),
    credentials: z
      .object({ username: z.string(), password: z.string() })
      .strict(),
  })
  .strict();
export type LabBrokerData = z.infer<typeof brokerData>;

export function parseLabBrokerData(text: string | undefined): LabBrokerData {
  if (text === undefined || text === '') {
    throw new ForeignEndpointError(
      'LAB_BROKER is not set; run it with `pnpm nx run conformance:record`',
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ForeignEndpointError('LAB_BROKER is not JSON');
  }
  const parsed = brokerData.safeParse(value);
  if (!parsed.success) {
    throw new ForeignEndpointError(
      `LAB_BROKER is malformed: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** A broker that testing/broker-lab created. Mint one with `verifyLabEndpoint`. */
export interface LabEndpoint {
  readonly version: string;
  /** The pinned digest of the official base image, from `versions.json`. */
  readonly digest: string;
  readonly amqpPort: number;
  readonly httpPort: number;
  readonly host: typeof LOOPBACK;
  readonly credentials: {
    readonly username: string;
    readonly password: string;
  };
}

const minted = new WeakSet();

/** Throws unless `value` is an endpoint minted by `verifyLabEndpoint` in this process. */
export function assertLabEndpoint(
  value: unknown,
): asserts value is LabEndpoint {
  if (typeof value !== 'object' || value === null || !minted.has(value)) {
    throw new ForeignEndpointError(
      'it was not created by testing/broker-lab (verifyLabEndpoint did not issue it)',
    );
  }
}

/** Runs `docker <args>`; tests replace it. */
export type Docker = (args: readonly string[]) => Promise<string>;

export const dockerCli: Docker = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      'docker',
      [...args],
      { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error)
          reject(new ForeignEndpointError(`docker ${args[0] ?? ''} failed`));
        else resolve(stdout);
      },
    );
  });

const inspected = z.array(
  z.object({
    Name: z.string(),
    Config: z.object({
      Image: z.string(),
      Labels: z.record(z.string(), z.string()).nullable(),
    }),
    State: z.object({ Running: z.boolean() }),
    NetworkSettings: z.object({
      Ports: z.record(
        z.string(),
        z
          .array(z.object({ HostIp: z.string(), HostPort: z.string() }))
          .nullable(),
      ),
    }),
  }),
);

/** The pinned digest of each lab version (`testing/broker-lab/versions.json`). */
export function loadPinnedDigests(
  file: URL = VERSIONS_FILE,
): ReadonlyMap<string, string> {
  const parsed = z
    .object({
      brokers: z.array(z.object({ version: z.string(), digest: z.string() })),
    })
    .safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) {
    throw new ForeignEndpointError(
      'testing/broker-lab/versions.json is malformed',
    );
  }
  return new Map(
    parsed.data.brokers.map((entry) => [entry.version, entry.digest]),
  );
}

function portOf(
  address: string,
  protocol: 'amqp:' | 'http:',
  what: string,
): number {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new ForeignEndpointError(`the ${what} address is not a URL`);
  }
  if (
    url.protocol !== protocol ||
    url.hostname !== LOOPBACK ||
    url.username !== '' ||
    url.password !== '' ||
    url.port === ''
  ) {
    throw new ForeignEndpointError(
      `the ${what} address must be ${protocol}//${LOOPBACK}:<port> without a login`,
    );
  }
  return Number(url.port);
}

export interface VerifyDeps {
  readonly docker?: Docker;
  readonly pinnedDigests?: ReadonlyMap<string, string>;
}

/**
 * Checks that the data describes a broker testing/broker-lab started, and mints the endpoint.
 * Every check is against the Docker daemon or the lab's own pins, never against the data alone.
 */
export async function verifyLabEndpoint(
  data: LabBrokerData,
  deps: VerifyDeps = {},
): Promise<LabEndpoint> {
  const docker = deps.docker ?? dockerCli;
  const pinned = (deps.pinnedDigests ?? loadPinnedDigests()).get(data.version);
  if (pinned === undefined || pinned !== data.digest) {
    throw new ForeignEndpointError(
      `${data.version} is not a pinned lab version with that digest`,
    );
  }
  const amqpPort = portOf(data.amqp, 'amqp:', 'AMQP');
  const httpPort = portOf(data.http, 'http:', 'management');
  const name = CONTAINER.exec(data.container);
  if (name?.[1] !== data.version) {
    throw new ForeignEndpointError(
      `container "${data.container}" is not named like a broker-lab ${data.version} container`,
    );
  }
  let entries: z.infer<typeof inspected>;
  try {
    entries = inspected.parse(
      JSON.parse(
        await docker(['inspect', '--type', 'container', data.container]),
      ),
    );
  } catch (error) {
    if (error instanceof ForeignEndpointError) throw error;
    throw new ForeignEndpointError(
      `cannot inspect container ${data.container}`,
    );
  }
  const [container] = entries;
  const labels = container?.Config.Labels ?? {};
  const published = (port: number): string[] =>
    (container?.NetworkSettings.Ports[`${String(port)}/tcp`] ?? []).map(
      (binding) => `${binding.HostIp}:${binding.HostPort}`,
    );
  const checks: [boolean, string][] = [
    [container?.Name === `/${data.container}`, 'the container name differs'],
    [container?.State.Running === true, 'the container is not running'],
    [
      container?.Config.Image === `broker-lab/rabbitmq:${data.version}`,
      'the container is not the lab image of this version',
    ],
    [
      labels[RUN_LABEL] === name[2] && labels[VERSION_LABEL] === data.version,
      'the container does not carry the broker-lab labels of this run',
    ],
    [
      published(5672).includes(`${LOOPBACK}:${String(amqpPort)}`),
      'the AMQP port is not the one broker-lab published on the loopback address',
    ],
    [
      published(15672).includes(`${LOOPBACK}:${String(httpPort)}`),
      'the management port is not the one broker-lab published on the loopback address',
    ],
  ];
  for (const [ok, reason] of checks) {
    if (!ok) throw new ForeignEndpointError(reason);
  }
  const endpoint: LabEndpoint = Object.freeze({
    version: data.version,
    digest: pinned,
    amqpPort,
    httpPort,
    host: LOOPBACK,
    credentials: Object.freeze({ ...data.credentials }),
  });
  minted.add(endpoint);
  return endpoint;
}
