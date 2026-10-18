// Broker-lab helpers (M0-14): start a digest-pinned RabbitMQ from testing/broker-lab and hand back
// its addresses. Containers are driven through the docker CLI (OQ-80), published on loopback only,
// on random host ports (so parallel worktrees do not collide) and removed by `stop()`.
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CONTAINER_PORTS,
  STREAM_CONF_TARGET,
  buildImageArgs,
  composeArgs,
  composeEnv,
  createContainerArgs,
  streamAdvertisedConf,
} from './lab/args.ts';
import {
  dockerCli,
  freePort,
  parseHostPort,
  type Docker,
} from './lab/docker.ts';
import {
  generateOAuthMaterial,
  generateTlsMaterial,
  type OAuthMaterial,
  type TlsMaterial,
} from './lab/material.ts';
import { httpGet, messageOf } from './lab/probes.ts';
import type { BrokerHandle, StartBrokerOptions } from './lab/types.ts';
import {
  LAB_DIR,
  findBroker,
  imageTag,
  loadBrokerVersions,
  type BrokerImage,
} from './lab/versions.ts';

export type { BrokerHandle, StartBrokerOptions, Variant } from './lab/types.ts';

const HOST = '127.0.0.1';
const CREDENTIALS = { username: 'guest', password: 'guest' } as const;

/** Things a test can replace: the docker runner, the lab folder and the version list. */
export interface BrokerLabDeps {
  readonly docker?: Docker;
  readonly labDir?: string;
  readonly brokers?: readonly BrokerImage[];
  /** Polling interval while waiting for the broker, in milliseconds. */
  readonly pollMs?: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits until `GET /api/overview` answers 200 with the lab credentials. `isAlive`, when given,
 * is asked between attempts so a broker that crashed at boot fails at once, not at the timeout.
 */
export async function waitForManagement(
  http: string,
  timeoutMs: number,
  pollMs = 1000,
  isAlive?: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 'no answer yet';
  while (Date.now() < deadline) {
    try {
      const { status } = await httpGet(`${http}/api/overview`, CREDENTIALS);
      if (status === 200) return;
      last = `status ${String(status)}`;
    } catch (error) {
      last = messageOf(error);
    }
    if (isAlive && !(await isAlive())) {
      throw new Error(`the broker stopped before ${http} answered (${last})`);
    }
    await sleep(pollMs);
  }
  throw new Error(
    `management API at ${http} not ready after ${String(timeoutMs)} ms (${last})`,
  );
}

const url = (scheme: string, port: number, path = ''): string =>
  `${scheme}://${HOST}:${String(port)}${path}`;

/**
 * Starts one lab broker, or the 3-node cluster, and resolves when the management API answers.
 *
 * ```ts
 * const broker = await startBroker({ version: '4.3.6' });
 * // broker.amqp, broker.http, broker.stream, broker.prometheus, broker.digest ...
 * await broker.stop();
 * ```
 */
export async function startBroker(
  options: StartBrokerOptions,
  deps: BrokerLabDeps = {},
): Promise<BrokerHandle> {
  const docker = deps.docker ?? dockerCli;
  const labDir = deps.labDir ?? LAB_DIR;
  const variant = options.variant ?? 'plain';
  const nodes = options.nodes ?? 1;
  if (nodes === 3 && variant !== 'plain') {
    throw new Error(
      `the 3-node lab is plain only; variant "${variant}" runs on one node`,
    );
  }
  const broker = findBroker(
    options.version,
    deps.brokers ?? loadBrokerVersions(labDir),
  );
  if (options.build !== false) {
    await docker(buildImageArgs(broker, labDir));
  }
  const context = {
    docker,
    labDir,
    broker,
    runId: randomBytes(4).toString('hex'),
    readyTimeoutMs: options.readyTimeoutMs ?? 180_000,
    pollMs: deps.pollMs ?? 1000,
  };
  return nodes === 3
    ? startCluster(context)
    : startSingle({ ...context, variant });
}

interface Context {
  readonly docker: Docker;
  readonly labDir: string;
  readonly broker: BrokerImage;
  readonly runId: string;
  readonly readyTimeoutMs: number;
  readonly pollMs: number;
}

async function startSingle(
  context: Context & { readonly variant: 'plain' | 'tls' | 'oauth' },
): Promise<BrokerHandle> {
  const { docker, labDir, broker, runId, variant } = context;
  const name = `broker-lab-${broker.version}-${runId}`;
  const scratch = mkdtempSync(join(tmpdir(), 'broker-lab-'));
  const cleanup = async (): Promise<void> => {
    await docker(['rm', '--force', '--volumes', name]).catch(() => '');
    rmSync(scratch, { recursive: true, force: true });
  };
  try {
    const streamPort = await freePort();
    let tls: TlsMaterial | undefined;
    let oauth: OAuthMaterial | undefined;
    if (variant === 'tls') tls = await generateTlsMaterial(scratch);
    if (variant === 'oauth') oauth = generateOAuthMaterial(scratch);

    await docker(
      createContainerArgs({
        name,
        image: imageTag(broker.version),
        runId,
        variant,
        streamPort,
      }),
    );
    const streamConf = join(scratch, '30-stream.conf');
    writeFileSync(streamConf, streamAdvertisedConf(streamPort));
    chmodSync(streamConf, 0o644);
    await docker(['cp', streamConf, `${name}:${STREAM_CONF_TARGET}`]);
    if (tls) {
      await docker(['cp', tls.dir, `${name}:/etc/rabbitmq/tls`]);
      await docker([
        'cp',
        join(labDir, 'tls', 'rabbitmq.tls.conf'),
        `${name}:/etc/rabbitmq/conf.d/30-tls.conf`,
      ]);
    }
    if (oauth) {
      await docker(['cp', oauth.dir, `${name}:/etc/rabbitmq/oauth`]);
      await docker([
        'cp',
        join(labDir, 'oauth', 'rabbitmq.oauth.conf'),
        `${name}:/etc/rabbitmq/conf.d/30-oauth.conf`,
      ]);
    }
    await docker(['start', name]);

    const hostPort = async (port: number): Promise<number> =>
      parseHostPort(await docker(['port', name, `${String(port)}/tcp`]));
    const http = url('http', await hostPort(CONTAINER_PORTS.http));
    const amqp = url('amqp', await hostPort(CONTAINER_PORTS.amqp));
    const prometheus = url(
      'http',
      await hostPort(CONTAINER_PORTS.prometheus),
      '/metrics',
    );
    const tlsPorts = tls
      ? {
          amqps: url('amqps', await hostPort(CONTAINER_PORTS.amqps)),
          https: url('https', await hostPort(CONTAINER_PORTS.https)),
          streamTls: url(
            'rabbitmq-stream+tls',
            await hostPort(CONTAINER_PORTS.streamTls),
          ),
        }
      : undefined;

    const running = async (): Promise<boolean> =>
      (
        await docker(['inspect', '--format', '{{.State.Running}}', name])
      ).trim() === 'true';
    await waitForManagement(
      http,
      context.readyTimeoutMs,
      context.pollMs,
      running,
    ).catch(async (error: unknown) => {
      const logs = await docker(['logs', '--tail', '120', name]).catch(
        () => '(no logs)',
      );
      throw new Error(`${messageOf(error)}\n--- container logs ---\n${logs}`);
    });

    return {
      version: broker.version,
      variant,
      nodes: 1,
      digest: broker.digest,
      container: name,
      amqp,
      http,
      stream: url('rabbitmq-stream', streamPort),
      prometheus,
      credentials: CREDENTIALS,
      ...(tlsPorts ?? {}),
      ...(tls ? { tls: { ca: readFileSync(tls.caPath, 'utf8') } } : {}),
      ...(oauth
        ? {
            oauth: {
              privateKey: oauth.privateKey,
              keyId: oauth.keyId,
              resourceServerId: oauth.resourceServerId,
            },
          }
        : {}),
      stop: cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function startCluster(context: Context): Promise<BrokerHandle> {
  const { docker, labDir, broker, runId } = context;
  const project = `broker-lab-${broker.version.replaceAll('.', '-')}-${runId}`;
  const composeFile = join(labDir, 'compose.3node.yaml');
  const streamPorts = [
    await freePort(),
    await freePort(),
    await freePort(),
  ] as const;
  const env = composeEnv(imageTag(broker.version), streamPorts);
  const compose = (...rest: string[]): Promise<string> =>
    docker(composeArgs(project, composeFile, ...rest), { env });
  const cleanup = async (): Promise<void> => {
    await compose(
      'down',
      '--volumes',
      '--remove-orphans',
      '--timeout',
      '1',
    ).catch(() => '');
  };
  try {
    await compose('up', '--detach', '--wait', '--wait-timeout', '240').catch(
      async (error: unknown) => {
        const logs = await compose('logs', '--tail', '150').catch(
          () => '(no logs)',
        );
        throw new Error(`${messageOf(error)}\n--- compose logs ---\n${logs}`);
      },
    );
    const hostPort = async (service: string, port: number): Promise<number> =>
      parseHostPort(await compose('port', service, String(port)));
    const http = url('http', await hostPort('haproxy', CONTAINER_PORTS.http));
    const amqp = url('amqp', await hostPort('haproxy', CONTAINER_PORTS.amqp));
    const prometheus = url(
      'http',
      await hostPort('haproxy', CONTAINER_PORTS.prometheus),
      '/metrics',
    );
    const toxiproxy = {
      api: url('http', await hostPort('toxiproxy', 8474)),
      amqp: url('amqp', await hostPort('toxiproxy', 25672)),
      management: url('http', await hostPort('toxiproxy', 25673)),
    };
    await waitForManagement(http, context.readyTimeoutMs, context.pollMs);
    return {
      version: broker.version,
      variant: 'plain',
      nodes: 3,
      digest: broker.digest,
      amqp,
      http,
      stream: url('rabbitmq-stream', streamPorts[0]),
      prometheus,
      credentials: CREDENTIALS,
      toxiproxy,
      stop: cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
