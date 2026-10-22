// The plan of `testkit:seed-lab` (a lab broker with something in it): parsing its options and building the
// definitions it imports, as plain data, with no broker and no Docker. The CLI (`seed-lab.ts`) applies the plan;
// this file is what the unit specs check: how many vhosts, queues of each type, exchanges and bindings a command
// line will create, and in which order the imports go (a binding needs its queue and its exchange first).
//
// Test tooling for a throwaway lab broker, not engine code: the engine never writes to a broker through it (I-2).
// Names are fixed by position, so two runs with the same options make the same broker.

/** The queue types of the mix, by position in a block of ten: seven classic, two quorum, one stream. */
const QUEUE_TYPE_MIX = [
  'classic',
  'classic',
  'classic',
  'classic',
  'classic',
  'classic',
  'classic',
  'quorum',
  'quorum',
  'stream',
] as const;

/** Exchange types, cycled by position in a vhost. */
const EXCHANGE_TYPES = ['direct', 'topic', 'fanout', 'headers'] as const;

/** Vhost names, in order; past the list they are `lab-<n>`. */
const VHOST_NAMES = ['shop', 'billing', 'shipping', 'audit'] as const;

export interface SeedOptions {
  /** The lab broker version to start (an exact version of `testing/broker-lab/versions.json`). */
  readonly version: string;
  /** Queues in all, spread evenly over the vhosts. */
  readonly queues: number;
  /** Vhosts to create (the default vhost `/` is left empty). */
  readonly vhosts: number;
  /** Exchanges to declare in each vhost. */
  readonly exchanges: number;
  /** Queues each exchange is bound to. */
  readonly bindings: number;
  /** Build the lab image first (a fresh checkout needs it once). */
  readonly build: boolean;
  /** `http://host:port` of a broker to seed instead of starting one; nothing is started or stopped then. */
  readonly existing: string | undefined;
  readonly user: string;
  readonly password: string;
}

export const DEFAULT_SEED_OPTIONS: SeedOptions = {
  version: '4.3.6',
  queues: 300,
  vhosts: 2,
  exchanges: 6,
  bindings: 4,
  build: true,
  existing: undefined,
  user: 'guest',
  password: 'guest',
};

export const SEED_USAGE = [
  'usage: pnpm nx run testkit:seed-lab -- [options]',
  '  --queues=300       queues in all, spread over the vhosts (1 to 100000)',
  '  --vhosts=2         vhosts to create (1 to 8); the default vhost "/" stays empty',
  '  --exchanges=6      exchanges per vhost (0 to 50)',
  '  --bindings=4       queues each exchange is bound to (0 to 20)',
  '  --version=4.3.6    lab broker version to start',
  '  --no-build         do not build the lab image first (it must exist already)',
  '  --existing=URL     seed the broker at this management URL instead of starting one',
  '  --user=guest --password=guest   the login for --existing',
  '  --help             this text',
].join('\n');

function integer(flag: string, text: string, min: number, max: number): number {
  if (!/^\d+$/.test(text)) {
    throw new Error(`${flag} must be a whole number, got "${text}"`);
  }
  const value = Number(text);
  if (value < min || value > max) {
    throw new Error(
      `${flag} must be between ${String(min)} and ${String(max)}`,
    );
  }
  return value;
}

/** Parses the command line; throws an `Error` whose message is what to tell the person. */
export function parseSeedArgs(
  argv: readonly string[],
  knownVersions: readonly string[],
): SeedOptions | 'help' {
  let options: SeedOptions = DEFAULT_SEED_OPTIONS;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg === '--no-build') {
      options = { ...options, build: false };
      continue;
    }
    const match = /^--([a-z]+)=(.*)$/.exec(arg);
    const name = match?.[1];
    const value = match?.[2];
    if (name === undefined || value === undefined) {
      throw new Error(`unknown option ${arg}`);
    }
    switch (name) {
      case 'queues':
        options = {
          ...options,
          queues: integer('--queues', value, 1, 100_000),
        };
        break;
      case 'vhosts':
        options = { ...options, vhosts: integer('--vhosts', value, 1, 8) };
        break;
      case 'exchanges':
        options = {
          ...options,
          exchanges: integer('--exchanges', value, 0, 50),
        };
        break;
      case 'bindings':
        options = { ...options, bindings: integer('--bindings', value, 0, 20) };
        break;
      case 'version':
        if (!knownVersions.includes(value)) {
          throw new Error(
            `"${value}" is not a lab version (${knownVersions.join(', ')})`,
          );
        }
        options = { ...options, version: value };
        break;
      case 'existing': {
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          throw new Error(
            `--existing must be a URL such as http://127.0.0.1:15672`,
          );
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          throw new Error('--existing must be an http or https URL');
        }
        options = { ...options, existing: url.origin };
        break;
      }
      case 'user':
        if (value === '') throw new Error('--user must not be empty');
        options = { ...options, user: value };
        break;
      case 'password':
        options = { ...options, password: value };
        break;
      default:
        throw new Error(`unknown option ${arg}`);
    }
  }
  return options;
}

export const vhostNameAt = (index: number): string =>
  VHOST_NAMES[index] ?? `lab-${String(index + 1)}`;
export const queueNameAt = (index: number): string =>
  `queue-${String(index).padStart(6, '0')}`;
const exchangeNameAt = (index: number, type: string): string =>
  `ex.${type}.${String(index).padStart(2, '0')}`;

type QueueType = (typeof QUEUE_TYPE_MIX)[number];

export interface SeedQueue {
  readonly name: string;
  readonly vhost: string;
  readonly durable: true;
  readonly auto_delete: false;
  readonly arguments: { readonly 'x-queue-type': QueueType };
}
export interface SeedExchange {
  readonly name: string;
  readonly vhost: string;
  readonly type: (typeof EXCHANGE_TYPES)[number];
  readonly durable: true;
  readonly auto_delete: false;
  readonly internal: false;
  readonly arguments: Record<string, never>;
}
export interface SeedBinding {
  readonly source: string;
  readonly vhost: string;
  readonly destination: string;
  readonly destination_type: 'queue' | 'exchange';
  readonly routing_key: string;
  readonly arguments: Record<string, string>;
}

/** Everything the run will declare, in the order it is imported. */
export interface SeedDefinitions {
  readonly vhosts: readonly string[];
  readonly queues: readonly SeedQueue[];
  readonly exchanges: readonly SeedExchange[];
  readonly bindings: readonly SeedBinding[];
}

/** What the data is, by construction: the same options always give the same definitions. */
export function buildDefinitions(
  options: Pick<SeedOptions, 'queues' | 'vhosts' | 'exchanges' | 'bindings'>,
): SeedDefinitions {
  const vhosts = Array.from({ length: options.vhosts }, (_, i) =>
    vhostNameAt(i),
  );
  const queues: SeedQueue[] = [];
  const queuesOf = vhosts.map(() => [] as SeedQueue[]);
  for (let i = 0; i < options.queues; i++) {
    const slot = i % options.vhosts;
    const queue: SeedQueue = {
      name: queueNameAt(i),
      vhost: vhosts[slot] ?? '',
      durable: true,
      auto_delete: false,
      arguments: {
        'x-queue-type': QUEUE_TYPE_MIX[i % QUEUE_TYPE_MIX.length] ?? 'classic',
      },
    };
    queues.push(queue);
    queuesOf[slot]?.push(queue);
  }

  const exchanges: SeedExchange[] = [];
  const bindings: SeedBinding[] = [];
  const seen = new Set<string>();
  const bind = (binding: SeedBinding): void => {
    const key = [
      binding.vhost,
      binding.source,
      binding.destination_type,
      binding.destination,
      binding.routing_key,
      JSON.stringify(binding.arguments),
    ].join('\u0000');
    if (seen.has(key)) return; // the broker would keep one binding, so the plan counts one
    seen.add(key);
    bindings.push(binding);
  };
  vhosts.forEach((vhost, slot) => {
    const local = queuesOf[slot] ?? [];
    const declared: SeedExchange[] = [];
    for (let j = 0; j < options.exchanges; j++) {
      const type = EXCHANGE_TYPES[j % EXCHANGE_TYPES.length] ?? 'direct';
      const exchange: SeedExchange = {
        name: exchangeNameAt(j, type),
        vhost,
        type,
        durable: true,
        auto_delete: false,
        internal: false,
        arguments: {},
      };
      declared.push(exchange);
      exchanges.push(exchange);
    }
    declared.forEach((exchange, j) => {
      for (let k = 0; k < options.bindings && local.length > 0; k++) {
        const target = local[(j * options.bindings + k) % local.length];
        if (target === undefined) continue;
        bind({
          source: exchange.name,
          vhost,
          destination: target.name,
          destination_type: 'queue',
          routing_key:
            exchange.type === 'fanout' || exchange.type === 'headers'
              ? ''
              : `route.${String(k)}`,
          arguments:
            exchange.type === 'headers'
              ? { 'x-match': 'all', topic: `t${String(k)}` }
              : {},
        });
      }
      const first = declared[0];
      if (j > 0 && first !== undefined) {
        bind({
          source: first.name,
          vhost,
          destination: exchange.name,
          destination_type: 'exchange',
          routing_key: 'fwd',
          arguments: {},
        });
      }
    });
  });
  return { vhosts, queues, exchanges, bindings };
}

/** What the run will create, for the person to read before and after. */
export interface SeedPlan {
  readonly vhosts: readonly string[];
  readonly queues: number;
  readonly queuesPerVhost: Readonly<Record<string, number>>;
  readonly queuesByType: Readonly<Record<QueueType, number>>;
  readonly exchanges: number;
  readonly bindings: number;
  /** Import requests the run makes. */
  readonly requests: number;
}

const BATCH = 2_500;

export function planSeed(options: SeedOptions): SeedPlan {
  const definitions = buildDefinitions(options);
  const perVhost: Record<string, number> = {};
  const byType: Record<QueueType, number> = {
    classic: 0,
    quorum: 0,
    stream: 0,
  };
  for (const queue of definitions.queues) {
    perVhost[queue.vhost] = (perVhost[queue.vhost] ?? 0) + 1;
    byType[queue.arguments['x-queue-type']] += 1;
  }
  return {
    vhosts: definitions.vhosts,
    queues: definitions.queues.length,
    queuesPerVhost: perVhost,
    queuesByType: byType,
    exchanges: definitions.exchanges.length,
    bindings: definitions.bindings.length,
    requests: importBodies(definitions, options.user).length,
  };
}

/**
 * The bodies of the `POST /api/definitions` requests, in the order they go: the vhosts, the login's permission on
 * each and the exchanges first, then the queues in blocks, then the bindings in blocks (a binding needs both ends).
 */
export function importBodies(
  definitions: SeedDefinitions,
  user: string,
): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [
    {
      vhosts: definitions.vhosts.map((name) => ({ name })),
      permissions: definitions.vhosts.map((vhost) => ({
        user,
        vhost,
        configure: '.*',
        write: '.*',
        read: '.*',
      })),
      exchanges: definitions.exchanges,
    },
  ];
  for (let from = 0; from < definitions.queues.length; from += BATCH) {
    bodies.push({ queues: definitions.queues.slice(from, from + BATCH) });
  }
  for (let from = 0; from < definitions.bindings.length; from += BATCH) {
    bodies.push({ bindings: definitions.bindings.slice(from, from + BATCH) });
  }
  return bodies;
}

/** The plan as the lines printed before anything is created. */
export function describePlan(plan: SeedPlan): string[] {
  return [
    `vhosts:    ${plan.vhosts.join(', ')} (the default vhost "/" stays empty)`,
    `queues:    ${String(plan.queues)} (${Object.entries(plan.queuesPerVhost)
      .map(([vhost, count]) => `${String(count)} in ${vhost}`)
      .join(
        ', ',
      )}; ${String(plan.queuesByType.classic)} classic, ${String(plan.queuesByType.quorum)} quorum, ${String(plan.queuesByType.stream)} stream)`,
    `exchanges: ${String(plan.exchanges)} (direct, topic, fanout and headers, per vhost)`,
    `bindings:  ${String(plan.bindings)} (exchange to queue, and exchange to exchange)`,
    `requests:  ${String(plan.requests)} definitions import(s)`,
  ];
}

/** The host and port of a broker URL, for the form. */
export function addressOf(url: string): { host: string; port: number } {
  const parsed = new URL(url);
  const DEFAULT_PORTS: Readonly<Record<string, number>> = {
    'http:': 80,
    'https:': 443,
    'amqp:': 5672,
    'amqps:': 5671,
  };
  const port =
    parsed.port === ''
      ? (DEFAULT_PORTS[parsed.protocol] ?? 0)
      : Number(parsed.port);
  return { host: parsed.hostname, port };
}
