// What the contract specs share: the two client libraries under test, the lab broker they run
// against (handed over by the global setup in `CONTRACT_BROKER`), and a few helpers. The specs
// never import the testkit (OQ-187); the broker is data, and the one thing a spec needs from the
// machine it runs on, `rabbitmqctl`, goes through `docker exec`.
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { createDialer } from '@app/net-dialer';

import {
  amqplibDriver,
  connectPublish,
  type Amqp091Driver,
  type ConnectOptions,
} from '../src/index.ts';
import { cloudamqpDriver } from './cloudamqp-driver.ts';

const run = promisify(execFile);

/** One client library behind the adapter's seam. */
export interface Subject {
  readonly name: string;
  readonly driver: Amqp091Driver;
  /** The product the library sends in its client properties; proves which library ran. */
  readonly product: string;
  /** SASL EXTERNAL: amqplib has it, @cloudamqp/amqp-client 4.1.1 is PLAIN only. */
  readonly external: boolean;
}

export const subjects: readonly Subject[] = [
  {
    name: 'amqplib',
    driver: amqplibDriver,
    product: 'amqplib',
    external: true,
  },
  {
    name: '@cloudamqp/amqp-client',
    driver: cloudamqpDriver,
    product: 'amqp-client.js',
    external: false,
  },
];

export interface ContractBroker {
  readonly version: string;
  readonly digest: string;
  readonly amqp: string;
  readonly http: string;
  readonly container: string;
  readonly credentials: {
    readonly username: string;
    readonly password: string;
  };
}

export function contractBroker(): ContractBroker {
  const raw = process.env.CONTRACT_BROKER;
  if (raw === undefined) {
    throw new Error(
      'CONTRACT_BROKER is not set: run the suite with `pnpm nx run adapter-amqp091:contract`',
    );
  }
  return JSON.parse(raw) as ContractBroker;
}

export const text = (value: string): Uint8Array =>
  new TextEncoder().encode(value);
export const decode = (value: Uint8Array): string =>
  new TextDecoder().decode(value);

let counter = 0;
/** A name no other test of this run uses. */
export function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(process.pid)}-${String(counter)}`;
}

export function portOf(address: string): number {
  return Number(new URL(address).port);
}

/** Connect options for one subject: every connection goes through the Dialer's forwarder. */
export function optionsFor(
  broker: ContractBroker,
  subject: Subject,
  session: string,
  extra: Partial<ConnectOptions> = {},
): ConnectOptions {
  return {
    dialer: createDialer(),
    route: { kind: 'direct' },
    endpoint: { host: '127.0.0.1', port: portOf(broker.amqp) },
    credentials: {
      kind: 'plain',
      username: broker.credentials.username,
      password: broker.credentials.password,
    },
    name: { product: 'product', mode: 'contract', session },
    heartbeatSeconds: 30,
    driver: subject.driver,
    ...extra,
  };
}

export async function management(
  broker: ContractBroker,
  method: 'GET' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<unknown> {
  const auth = Buffer.from(
    `${broker.credentials.username}:${broker.credentials.password}`,
  ).toString('base64');
  const response = await fetch(`${broker.http}/api${path}`, {
    method,
    headers: {
      authorization: `Basic ${auth}`,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`${method} ${path} answered ${String(response.status)}`);
  }
  const raw = await response.text();
  return raw === '' ? undefined : JSON.parse(raw);
}

export type QueueKind = 'classic' | 'quorum';

export async function declare(
  broker: ContractBroker,
  name: string,
  type: QueueKind,
  args: Record<string, unknown> = {},
): Promise<void> {
  await management(broker, 'PUT', `/queues/%2F/${encodeURIComponent(name)}`, {
    durable: true,
    arguments: { 'x-queue-type': type, ...args },
  });
}

export async function deleteQueue(
  broker: ContractBroker,
  name: string,
): Promise<void> {
  await management(broker, 'DELETE', `/queues/%2F/${encodeURIComponent(name)}`);
}

/** Publishes `bodies` to a queue through the adapter's own publish lease of that library. */
export async function fill(
  broker: ContractBroker,
  subject: Subject,
  queue: string,
  bodies: readonly string[],
): Promise<void> {
  const { lease } = await connectPublish(
    optionsFor(broker, subject, unique('fill')),
  );
  for (const body of bodies) {
    const outcome = await lease.publish('', queue, text(body), {}, MANDATORY);
    if (outcome.outcome !== 'confirmed') {
      throw new Error(`filling ${queue} gave ${outcome.outcome}`);
    }
  }
  await lease.release();
}

export const MANDATORY = { mandatory: true, timeoutMs: 10_000 } as const;

/** `docker exec <container> rabbitmqctl ...args`; the output is returned. */
export async function rabbitmqctl(
  broker: ContractBroker,
  ...args: string[]
): Promise<string> {
  const { stdout } = await run(
    'docker',
    ['exec', broker.container, 'rabbitmqctl', ...args],
    { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
  );
  return stdout;
}

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
  what = 'the condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Writes an observation the contract suite made to `dist/contract-evidence/<broker>/<name>.json`
 * (or `CONTRACT_EVIDENCE_DIR`). It is a candidate for the lab evidence of the matching cell, not
 * evidence itself: evidence is recorded by CI and committed by a human (I-14), so nothing here
 * writes under `testing/lab-evidence`.
 */
export function recordObservation(
  broker: ContractBroker,
  name: string,
  observation: unknown,
): void {
  const dir = join(
    process.env.CONTRACT_EVIDENCE_DIR ??
      join(process.cwd(), 'dist', 'contract-evidence'),
    broker.version,
  );
  mkdirSync(dir, { recursive: true });
  const record = {
    brokerVersion: broker.version,
    image: broker.digest,
    recordedAt: new Date().toISOString(),
    observation,
  };
  writeFileSync(
    join(dir, `${name}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  console.info(
    `contract observation ${name} on ${broker.version}: ${JSON.stringify(observation)}`,
  );
}
