// A broker to record from (M0-25): a lab RabbitMQ (statistics on, or off through configuration) or
// LavinMQ. Each recording gets a fresh broker, so a fixture never depends on what an earlier one
// left behind. Containers are driven through the docker CLI, published on loopback only.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startBroker, waitForManagement } from '../broker-lab.ts';
import { dockerCli, parseHostPort, type Docker } from '../lab/docker.ts';
import type { StatsMode } from './types.ts';

export interface Session {
  /** `http://127.0.0.1:<port>`: the management API is at `/api`. */
  readonly http: string;
  /** `http://127.0.0.1:<port>`: the Prometheus page is at `/metrics`. */
  readonly prometheus: string;
  readonly amqpPort: number;
  readonly login: { readonly username: string; readonly password: string };
  readonly container: string;
  /** Host-specific names to replace, with their replacements, for the scrubber. */
  readonly hosts: Readonly<Record<string, string>>;
  /** Configuration this session added to the product's own defaults. */
  readonly brokerConfig: readonly string[];
  stop(): Promise<void>;
}

/** `management.disable_stats` and the metrics collector: what an operator sets to switch stats off. */
export const STATS_OFF_CONFIG: readonly string[] = [
  'management.disable_stats = true',
  'management_agent.disable_metrics_collector = true',
];

const LOGIN = { username: 'guest', password: 'guest' } as const;
const HOST = '127.0.0.1';

/** The names the container gives the broker, mapped to what the fixtures say instead. */
async function hostsOf(
  docker: Docker,
  container: string,
): Promise<Record<string, string>> {
  const out = await docker([
    'inspect',
    '--format',
    '{{.Config.Hostname}}|{{.Id}}|{{.Name}}',
    container,
  ]);
  const [hostname = '', id = '', name = ''] = out.trim().split('|');
  const hosts: Record<string, string> = {};
  if (hostname.length >= 3) hosts[hostname] = 'lab-node';
  if (id.length >= 12) {
    hosts[id] = 'lab-container';
    hosts[id.slice(0, 12)] = 'lab-node';
  }
  const bare = name.replace(/^\//, '');
  if (bare.length >= 3) hosts[bare] = 'lab-container';
  return hosts;
}

async function publishedPort(
  docker: Docker,
  container: string,
  port: number,
): Promise<number> {
  // Right after a restart the port mapping can be missing for a moment.
  for (let attempt = 1; ; attempt += 1) {
    try {
      return parseHostPort(
        await docker(['port', container, `${String(port)}/tcp`]),
      );
    } catch (error) {
      if (attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function addresses(docker: Docker, container: string) {
  return {
    http: `http://${HOST}:${String(await publishedPort(docker, container, 15672))}`,
    prometheus: `http://${HOST}:${String(await publishedPort(docker, container, 15692))}`,
    amqpPort: await publishedPort(docker, container, 5672),
  };
}

/** A lab RabbitMQ of `version`; with `stats-off` it is restarted with the statistics switched off. */
export async function startRabbitMq(
  version: string,
  mode: StatsMode,
  docker: Docker = dockerCli,
): Promise<Session> {
  const broker = await startBroker({ version });
  const container = broker.container;
  if (container === undefined) {
    await broker.stop();
    throw new Error('the lab broker did not report its container');
  }
  try {
    let brokerConfig: readonly string[] = [];
    if (mode === 'stats-off') {
      brokerConfig = STATS_OFF_CONFIG;
      const scratch = mkdtempSync(join(tmpdir(), 'golden-conf-'));
      try {
        const file = join(scratch, '40-stats-off.conf');
        writeFileSync(file, `${STATS_OFF_CONFIG.join('\n')}\n`);
        chmodSync(file, 0o644);
        await docker([
          'cp',
          file,
          `${container}:/etc/rabbitmq/conf.d/40-stats-off.conf`,
        ]);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
      await docker(['restart', '--time', '10', container]);
    }
    // A restart may give the published ports new numbers: ask Docker again, and say why when the
    // broker did not come back (a configuration key it does not know stops it at boot).
    const where = await addresses(docker, container).catch(
      async (error: unknown) => {
        const logs = await docker(['logs', '--tail', '60', container]).catch(
          () => '(no logs)',
        );
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n--- container logs ---\n${logs}`,
        );
      },
    );
    if (mode === 'stats-off') {
      await waitForManagement(where.http, 180_000);
    }
    return {
      ...where,
      login: LOGIN,
      container,
      hosts: await hostsOf(docker, container),
      brokerConfig,
      stop: () => broker.stop(),
    };
  } catch (error) {
    await broker.stop();
    throw error;
  }
}

/** LavinMQ, pinned by digest. It listens on loopback inside the container unless told otherwise. */
export async function startLavinMq(
  image: string,
  digest: string,
  docker: Docker = dockerCli,
): Promise<Session> {
  const container = `golden-lavinmq-${randomBytes(4).toString('hex')}`;
  const cleanup = async (): Promise<void> => {
    await docker(['rm', '--force', '--volumes', container]).catch(() => '');
  };
  try {
    await docker([
      'run',
      '--detach',
      '--name',
      container,
      '--publish',
      `${HOST}::15672`,
      '--publish',
      `${HOST}::5672`,
      '--publish',
      `${HOST}::15692`,
      `${image}@${digest}`,
      // The image already binds 0.0.0.0 and lets guest in from outside the container; the
      // Prometheus page binds loopback by default, which a published port cannot reach.
      '--metrics-http-bind=0.0.0.0',
    ]);
    const where = await addresses(docker, container);
    await waitForManagement(where.http, 120_000);
    return {
      ...where,
      login: LOGIN,
      container,
      hosts: await hostsOf(docker, container),
      brokerConfig: ['--metrics-http-bind=0.0.0.0'],
      stop: cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
