// Product awareness (DC-55): the management API of another product looks like RabbitMQ's and
// differs where it matters. This file holds the two things the adapter does about it: it names the
// product from `/api/overview`, and it makes the `/get` body safe for products that read it
// differently. Version-dependent behaviour is not decided here (I-3): that is the registry's.
import type { Product } from '@app/domain-model';

import type { Overview } from './endpoints/overview.ts';

const RABBITMQ_FAMILY: readonly Product[] = ['rabbitmq', 'tanzu-rabbitmq'];

/** True for the products whose management API is RabbitMQ's own. */
export function isRabbitMqFamily(product: Product): boolean {
  return RABBITMQ_FAMILY.includes(product);
}

/**
 * Names the product from what `/api/overview` says about itself: `product_name`, and the
 * version keys (`rabbitmq_version` is absent on LavinMQ, which reports `lavinmq_version`). A
 * product it cannot name is `unknown`, which every rule treats conservatively.
 */
export function productFromOverview(
  overview: Pick<
    Overview,
    'product_name' | 'rabbitmq_version' | 'lavinmq_version'
  >,
): Product {
  const name = (overview.product_name ?? '').toLowerCase();
  if (name.includes('lavinmq') || overview.lavinmq_version !== undefined) {
    return 'lavinmq';
  }
  if (name.includes('tanzu')) return 'tanzu-rabbitmq';
  if (name.includes('apsara')) return 'apsaramq';
  if (name.includes('rabbitmq') || overview.rabbitmq_version !== undefined) {
    return 'rabbitmq';
  }
  return 'unknown';
}

/** `POST /api/queues/{vhost}/{name}/get`. */
const GET_MESSAGES_PATH = /^\/api\/queues\/[^/]+\/[^/]+\/get$/;

export function isGetMessagesPath(path: string): boolean {
  return GET_MESSAGES_PATH.test(path);
}

/**
 * The `/get` body for a product other than RabbitMQ (DC-55). On LavinMQ a missing `ackmode` means
 * ack, and `ack_requeue_true` rejects without requeue unless the body also says `requeue: true`
 * (fact sheet b.7). So the body always carries an explicit `ackmode` (default
 * `ack_requeue_true`) and `requeue: true`. A caller that chose a mode that discards the message
 * (`*_requeue_false`) keeps its choice: `requeue` is then `false`, never silently reversed.
 * RabbitMQ's own body is sent as the caller wrote it.
 */
export function normaliseGetMessagesBody(
  product: Product,
  body: unknown,
): unknown {
  if (isRabbitMqFamily(product)) return body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return body;
  }
  const fields = body as Record<string, unknown>;
  const ackmode =
    typeof fields.ackmode === 'string' ? fields.ackmode : 'ack_requeue_true';
  return { ...fields, ackmode, requeue: !ackmode.endsWith('_requeue_false') };
}
