import { signLabToken } from './material.ts';
import type { BrokerHandle } from './types.ts';
import {
  fail,
  httpGet,
  httpJson,
  messageOf,
  pass,
  probeAmqp,
  probeStream,
  type Check,
} from './probes.ts';

/** Plugins whose management extension `/api/extensions` must list (M0-14 acceptance criteria). */
export const REQUIRED_EXTENSIONS = [
  'shovel',
  'federation',
  'stream',
  'tracing',
] as const;

/** Exchange type and exchange the consistent-hash and event-exchange plugins provide. */
export const CONSISTENT_HASH_TYPE = 'x-consistent-hash';
export const EVENT_EXCHANGE = 'amq.rabbitmq.event';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hostOf = (url: string): string => new URL(url).hostname;
const portOf = (url: string): number => Number(new URL(url).port);

/**
 * Names of the management extensions in the body of `GET /api/extensions`. An entry's `javascript`
 * is one file name up to 4.2 and may be a list of file names from 4.3 (for example
 * `["federation_management-ejs.js","federation.js"]`); 4.3 also returns empty lists as entries.
 */
export function extensionNames(body: unknown): string[] {
  if (!Array.isArray(body)) return [];
  return (body as unknown[]).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const files: unknown[] = Array.isArray(entry.javascript)
      ? (entry.javascript as unknown[])
      : [entry.javascript];
    return files.flatMap((file) =>
      typeof file === 'string' ? [file.replace(/\.js$/, '')] : [],
    );
  });
}

/** Exchange type names in the body of `GET /api/overview`. */
export function exchangeTypes(overview: unknown): string[] {
  if (!isRecord(overview) || !Array.isArray(overview.exchange_types)) {
    return [];
  }
  return (overview.exchange_types as unknown[]).flatMap((entry) =>
    isRecord(entry) && typeof entry.name === 'string' ? [entry.name] : [],
  );
}

async function check(
  name: string,
  body: () => Promise<string>,
): Promise<Check> {
  try {
    return pass(name, await body());
  } catch (error) {
    return fail(name, messageOf(error));
  }
}

/**
 * Runs the M0-14 checks against a running broker: the AMQP, management, stream and Prometheus
 * ports answer, the management API reports exactly the version that was asked for, and the
 * plugins the conformance matrix needs are active. Never throws; every problem is a failed check.
 */
export async function verifyBroker(
  handle: BrokerHandle,
  options: { readonly clusterWaitMs?: number } = {},
): Promise<Check[]> {
  const auth = {
    username: handle.credentials.username,
    password: handle.credentials.password,
  };
  const api = (path: string): string => `${handle.http}/api/${path}`;
  const checks: Check[] = [];

  checks.push(await probeAmqp(hostOf(handle.amqp), portOf(handle.amqp)));
  checks.push(await probeStream(hostOf(handle.stream), portOf(handle.stream)));

  let overview: unknown;
  checks.push(
    await check(`management ${String(portOf(handle.http))}`, async () => {
      overview = await httpJson(api('overview'), auth);
      return 'GET /api/overview answered 200';
    }),
  );
  checks.push(
    await check('rabbitmq_version equals the tag', () => {
      const reported = isRecord(overview)
        ? overview.rabbitmq_version
        : undefined;
      if (reported !== handle.version) {
        return Promise.reject(
          new Error(
            `/api/overview reports ${JSON.stringify(reported)}, expected ${handle.version}`,
          ),
        );
      }
      return Promise.resolve(`rabbitmq_version ${handle.version}`);
    }),
  );
  checks.push(
    await check(`prometheus ${String(portOf(handle.prometheus))}`, async () => {
      const { status, body } = await httpGet(handle.prometheus);
      if (status !== 200 || !body.includes('rabbitmq_')) {
        throw new Error(
          `GET ${handle.prometheus} answered ${String(status)} without rabbitmq_ metrics`,
        );
      }
      return 'GET /metrics answered 200 with rabbitmq_ metrics';
    }),
  );
  checks.push(
    await check('/api/extensions lists the plugins', async () => {
      const names = extensionNames(await httpJson(api('extensions'), auth));
      const missing = REQUIRED_EXTENSIONS.filter(
        (plugin) => !names.some((name) => name.includes(plugin)),
      );
      if (missing.length > 0) {
        throw new Error(
          `missing ${missing.join(', ')}; the broker lists ${names.join(', ')}`,
        );
      }
      return `lists ${REQUIRED_EXTENSIONS.join(', ')}`;
    }),
  );
  checks.push(
    await check('consistent-hash and event exchanges exist', async () => {
      if (!exchangeTypes(overview).includes(CONSISTENT_HASH_TYPE)) {
        throw new Error(`exchange type ${CONSISTENT_HASH_TYPE} is not offered`);
      }
      await httpJson(api(`exchanges/%2F/${EVENT_EXCHANGE}`), auth);
      return `${CONSISTENT_HASH_TYPE} is offered and ${EVENT_EXCHANGE} exists`;
    }),
  );

  if (handle.amqps !== undefined && handle.tls) {
    const ca = handle.tls.ca;
    checks.push(
      await probeAmqp(hostOf(handle.amqps), portOf(handle.amqps), {
        ca,
        servername: 'localhost',
      }),
    );
    if (handle.https !== undefined) {
      const https = handle.https;
      checks.push(
        await check(`management TLS ${String(portOf(https))}`, async () => {
          await httpJson(`${https}/api/overview`, { ...auth, ca });
          return 'GET /api/overview over TLS answered 200';
        }),
      );
    }
  }

  if (handle.oauth) {
    const oauth = handle.oauth;
    checks.push(
      await check('a lab-signed token logs in as administrator', async () => {
        const token = signLabToken(oauth, {
          subject: 'lab-admin',
          scope: ['rabbitmq.tag:administrator'],
        });
        // the oauth2 backend takes the token as the password; the user name comes from the token
        const whoami = await httpJson(api('whoami'), {
          username: 'ignored',
          password: token,
        });
        const tags = isRecord(whoami) ? whoami.tags : undefined;
        const listed = Array.isArray(tags) ? tags : String(tags).split(',');
        if (!listed.includes('administrator')) {
          throw new Error(`/api/whoami reports tags ${JSON.stringify(tags)}`);
        }
        return 'token accepted, tag administrator';
      }),
    );
  }

  if (handle.nodes === 3) {
    checks.push(
      await check('three nodes are running', async () => {
        // the nodes join one after the other, so allow them a moment
        const deadline = Date.now() + (options.clusterWaitMs ?? 60_000);
        for (;;) {
          const nodes = await httpJson(api('nodes'), auth);
          const running = Array.isArray(nodes)
            ? (nodes as unknown[]).filter(
                (node) => isRecord(node) && node.running === true,
              ).length
            : 0;
          if (running === 3) return '3 nodes running behind HAProxy';
          if (Date.now() >= deadline) {
            throw new Error(`${String(running)} nodes running, expected 3`);
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }),
    );
    if (handle.toxiproxy) {
      const toxiproxy = handle.toxiproxy;
      checks.push(
        await check('toxiproxy answers', async () => {
          const { status } = await httpGet(`${toxiproxy.api}/version`);
          if (status !== 200) {
            throw new Error(`GET /version answered ${String(status)}`);
          }
          return 'control API answered 200';
        }),
      );
    }
  }

  return checks;
}
