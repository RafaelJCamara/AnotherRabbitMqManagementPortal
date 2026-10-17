import { imageTag, type BrokerImage } from './versions.ts';

export type Variant = 'plain' | 'tls' | 'oauth';

/** Ports inside the container (the broker-lab Dockerfile exposes the same list). */
export const CONTAINER_PORTS = {
  amqp: 5672,
  amqps: 5671,
  http: 15672,
  https: 15671,
  stream: 5552,
  streamTls: 5551,
  prometheus: 15692,
} as const;

/** The label every container and compose project of one run carries, so a stray one can be found. */
export const RUN_LABEL = 'io.broker-lab.run';

/** Arguments of `docker build` for one version. */
export function buildImageArgs(broker: BrokerImage, labDir: string): string[] {
  return [
    'build',
    '--file',
    `${labDir}Dockerfile`,
    '--build-arg',
    `VERSION=${broker.version}`,
    '--build-arg',
    `DIGEST=${broker.digest}`,
    '--tag',
    imageTag(broker.version),
    labDir,
  ];
}

/**
 * The stream client is told this address by the broker, so it must be the address the host reaches
 * the stream port on. That makes the host port a fixed choice made before the container starts,
 * and the advertised address a configuration fragment written for the run (30-stream.conf).
 */
export const streamAdvertisedConf = (port: number): string =>
  `stream.advertised_host = 127.0.0.1\nstream.advertised_port = ${String(port)}\n`;

/** Where the fragments of a run are copied to inside the container. */
export const STREAM_CONF_TARGET = '/etc/rabbitmq/conf.d/30-stream.conf';

export interface ContainerSpec {
  readonly name: string;
  readonly image: string;
  readonly runId: string;
  readonly variant: Variant;
  readonly streamPort: number;
}

/**
 * Arguments of `docker create` for a single node. Every port is published on the loopback
 * interface only (no new listeners on the network), on a random host port except the stream port.
 */
export function createContainerArgs(spec: ContainerSpec): string[] {
  const published = [
    CONTAINER_PORTS.amqp,
    CONTAINER_PORTS.http,
    CONTAINER_PORTS.prometheus,
    ...(spec.variant === 'tls'
      ? [
          CONTAINER_PORTS.amqps,
          CONTAINER_PORTS.https,
          CONTAINER_PORTS.streamTls,
        ]
      : []),
  ].flatMap((port) => ['--publish', `127.0.0.1::${String(port)}`]);
  return [
    'create',
    '--name',
    spec.name,
    '--label',
    `${RUN_LABEL}=${spec.runId}`,
    ...published,
    '--publish',
    `127.0.0.1:${String(spec.streamPort)}:${String(CONTAINER_PORTS.stream)}`,
    spec.image,
  ];
}

/** Arguments of `docker compose` for the 3-node project. */
export const composeArgs = (
  project: string,
  composeFile: string,
  ...rest: string[]
): string[] => [
  'compose',
  '--project-name',
  project,
  '--file',
  composeFile,
  ...rest,
];

/** Variables the 3-node compose file requires. */
export const composeEnv = (
  image: string,
  streamPorts: readonly [number, number, number],
): Record<string, string> => ({
  BROKER_IMAGE: image,
  STREAM_PORT_1: String(streamPorts[0]),
  STREAM_PORT_2: String(streamPorts[1]),
  STREAM_PORT_3: String(streamPorts[2]),
});
