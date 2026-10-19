// The topology of every recording (M0-25): `testing/fixtures/seed.json` is a list of management
// API calls run in order against a fresh broker, then one consumer that holds two unacknowledged
// messages, so the lists, the consumer and channel endpoints and the message counts have content.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { connectSource } from '@app/adapter-amqp091';
import type { Product } from '@app/domain-model';
import { createDialer } from '@app/net-dialer';
import { z } from 'zod';

import { call } from './http.ts';
import { CANARY_SECRET } from './scrub.ts';
import type { Session } from './session.ts';

export const FIXTURES_DIR = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'testing',
  'fixtures',
);

const StepSchema = z.strictObject({
  name: z.string().min(1),
  method: z.enum(['PUT', 'POST']),
  path: z.string().startsWith('/api/'),
  body: z.unknown().optional(),
  products: z.array(z.string()).optional(),
  optional: z.boolean().optional(),
  repeat: z.number().int().min(1).max(20).optional(),
});

const SeedSchema = z.strictObject({
  $comment: z.string().optional(),
  id: z.string().min(1),
  steps: z.array(StepSchema).min(1),
  consumer: z.strictObject({
    vhost: z.string(),
    queue: z.string(),
    prefetch: z.number().int().min(1),
  }),
});
export type Seed = z.infer<typeof SeedSchema>;
export type SeedStep = z.infer<typeof StepSchema>;

export interface LoadedSeed {
  readonly seed: Seed;
  /** SHA-256 of the file's bytes: the manifest records which seed produced the fixtures. */
  readonly sha256: string;
}

export function loadSeed(dir: string = FIXTURES_DIR): LoadedSeed {
  const bytes = readFileSync(join(dir, 'seed.json'));
  return {
    seed: SeedSchema.parse(JSON.parse(bytes.toString('utf8'))),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/** The steps that apply to `product`. */
export function stepsFor(seed: Seed, product: Product): SeedStep[] {
  return seed.steps.filter(
    (step) => step.products === undefined || step.products.includes(product),
  );
}

/** The secret value in a body is a placeholder in the file and the canary at run time. */
export function withCanary(body: unknown): unknown {
  if (body === undefined) return undefined;
  return JSON.parse(
    JSON.stringify(body).replaceAll('@CANARY@', CANARY_SECRET),
  ) as unknown;
}

export interface SeedResult {
  /** Optional steps the broker refused: `<name> (<status>)`. */
  readonly refused: string[];
  /** Closes the consumer connection. */
  readonly stop: () => Promise<void>;
}

const OK = (status: number): boolean => status >= 200 && status < 300;

export async function applySeed(
  session: Session,
  product: Product,
  loaded: LoadedSeed = loadSeed(),
): Promise<SeedResult> {
  const refused: string[] = [];
  for (const step of stepsFor(loaded.seed, product)) {
    for (let n = 0; n < (step.repeat ?? 1); n += 1) {
      const reply = await call(session.http, step.method, step.path, {
        login: session.login,
        ...(step.body === undefined ? {} : { body: withCanary(step.body) }),
      });
      if (OK(reply.status)) continue;
      if (step.optional !== true) {
        throw new Error(
          `seed step "${step.name}" was refused with ${String(reply.status)}: ${reply.text.slice(0, 200)}`,
        );
      }
      refused.push(`${step.name} (${String(reply.status)})`);
      break;
    }
  }

  // The consumer: one connection, one channel, `prefetch` deliveries held and never acknowledged.
  const { vhost, queue, prefetch } = loaded.seed.consumer;
  const opened = await connectSource({
    dialer: createDialer(),
    route: { kind: 'direct' },
    endpoint: { host: '127.0.0.1', port: session.amqpPort, vhost },
    credentials: {
      kind: 'plain',
      username: session.login.username,
      password: session.login.password,
    },
    name: { product: 'golden', mode: 'recorder', session: 'seed' },
    heartbeatSeconds: 30,
  });
  try {
    await opened.lease.consume(queue, prefetch, () => undefined);
  } catch (error) {
    await opened.lease.release('poisoned');
    throw error;
  }
  return {
    refused,
    stop: () => opened.lease.release('poisoned'),
  };
}
