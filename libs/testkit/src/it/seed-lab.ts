// `testkit:seed-lab`: starts a lab broker (or takes one you already run), puts something in it, prints what to type
// into the connection form, and keeps the broker until Ctrl+C.
//
//   pnpm nx run testkit:seed-lab -- --queues=300 --vhosts=2
//   node libs/testkit/src/it/seed-lab.ts --help
//
// It is test tooling for a throwaway broker, not engine code (I-2: the engine never writes to a broker through
// it). It imports definitions (`POST /api/definitions`): vhosts, the login's permission on them, exchanges, queues
// of three types and bindings, in blocks, so a few hundred queues are a handful of requests. It creates no
// message, no connection and no consumer, so the Connections list stays empty until a client connects.
// Needs a Docker daemon unless `--existing` names a broker. Node runs this file directly (erasable TypeScript only).
import { spawnSync } from 'node:child_process';

import { startBroker } from '../broker-lab.ts';
import { call } from '../golden/http.ts';
import { loadBrokerVersions } from '../lab/versions.ts';
import {
  addressOf,
  buildDefinitions,
  describePlan,
  importBodies,
  parseSeedArgs,
  planSeed,
  SEED_USAGE,
} from './seed-plan.ts';
import { waitForQueueTotal } from './seed-queues.ts';

const say = (line = ''): void => {
  process.stdout.write(line + '\n');
};

let options: ReturnType<typeof parseSeedArgs>;
try {
  options = parseSeedArgs(
    process.argv.slice(2),
    loadBrokerVersions().map((broker) => broker.version),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(SEED_USAGE);
  process.exit(2);
}
if (options === 'help') {
  say(SEED_USAGE);
  process.exit(0);
}

const plan = planSeed(options);
say('Seeding a broker with:');
for (const line of describePlan(plan)) say(`  ${line}`);
say();

if (options.existing === undefined) {
  const docker = spawnSync('docker', ['info'], {
    stdio: 'ignore',
    timeout: 30_000,
  });
  if (docker.status !== 0) {
    console.error(
      'testkit:seed-lab needs a running Docker daemon (docker info failed), or --existing=<management URL> of a broker you run yourself.',
    );
    process.exit(1);
  }
}

const login = { username: options.user, password: options.password };
const broker =
  options.existing === undefined
    ? await (async () => {
        say(
          `Starting RabbitMQ ${options.version} from the lab image${options.build ? ' (building it first, once)' : ''}...`,
        );
        return startBroker({ version: options.version, build: options.build });
      })()
    : undefined;
const origin = broker?.http ?? options.existing ?? '';
const brokerLogin = broker?.credentials ?? login;

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  say();
  say('Stopping...');
  if (broker !== undefined) await broker.stop();
  say(
    broker === undefined
      ? 'Done. The broker you pointed at is left running, with the seeded data in it.'
      : 'Done. The lab broker is removed.',
  );
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
if (broker?.container !== undefined) {
  say(
    `If this process is ever killed without cleaning up, remove the broker with: docker rm --force --volumes ${broker.container}`,
  );
}

try {
  const bodies = importBodies(buildDefinitions(options), brokerLogin.username);
  say(`Importing ${String(bodies.length)} block(s) of definitions...`);
  let done = 0;
  for (const body of bodies) {
    const reply = await call(origin, 'POST', '/api/definitions', {
      login: brokerLogin,
      body,
    });
    done += 1;
    if (reply.status !== 204) {
      throw new Error(
        `the broker answered ${String(reply.status)} to block ${String(done)} of ${String(bodies.length)}: ${reply.text.slice(0, 300)}`,
      );
    }
  }
  if (broker !== undefined) {
    // The broker's own total comes from its metrics collector and can trail the import by a few seconds.
    await waitForQueueTotal({
      origin,
      login: brokerLogin,
      expected: plan.queues,
      timeoutMs: 120_000,
    }).catch((error: unknown) => {
      say(
        `Note: ${error instanceof Error ? error.message : String(error)}. The queues are imported; the broker's counters are still catching up.`,
      );
    });
  }
} catch (error) {
  console.error(
    `seeding failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  await stop();
}

const http = addressOf(origin);
const amqp = broker === undefined ? undefined : addressOf(broker.amqp);
say();
say('Ready. In the app, open "Add a connection" and type:');
say('  Name:                 Lab seed (any name)');
say('  Environment class:    development');
say(`  Management host:      ${http.host}`);
say(`  Management port:      ${String(http.port)}`);
say(
  `  Management login:     ${brokerLogin.username} / ${brokerLogin.password}`,
);
say(
  amqp === undefined
    ? '  AMQP host and port:   those your broker publishes (5672 by default); leave the virtual host as /'
    : `  AMQP host and port:   ${amqp.host} / ${String(amqp.port)}   (virtual host / )`,
);
say('  Leave TLS off, and keep "use the same login for AMQP" on.');
say();
say(`Management UI of the broker itself (to compare numbers): ${origin}`);
say('Press Ctrl+C to stop the broker and remove it.');

// Keep the process (and the broker) alive until a signal arrives.
setInterval(() => undefined, 1 << 30);
