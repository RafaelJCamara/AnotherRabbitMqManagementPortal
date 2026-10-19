// Which product and which provider the facts describe. Both are conservative: a contradiction or a
// missing fact is `unknown`, and `unknown` has a preset that assumes nothing.
import type { Product, Provider } from '@app/domain-model';
import type { BrokerSemanticsRegistry } from '@app/semantics';

import { providerOfHost } from './providers';
import type { Facts } from './types';

const RABBITMQ_FAMILY: readonly Product[] = ['rabbitmq', 'tanzu-rabbitmq'];

export const isRabbitMqFamily = (product: Product): boolean =>
  RABBITMQ_FAMILY.includes(product);

/** From `/api/overview`: `product_name` and the version keys (LavinMQ has no `rabbitmq_version`). */
export function productOf(facts: Facts): Product {
  const overview = facts.overviews[0]?.overview;
  if (overview === undefined) return 'unknown';
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

/**
 * The provider the host name and the provider-owned objects agree on. Two different answers, or
 * none, are `unknown`; a loopback address alone is a broker on this machine.
 */
export function providerOf(
  registry: BrokerSemanticsRegistry,
  facts: Facts,
): Provider {
  const named = new Set<Provider>(facts.vendor?.providers ?? []);
  const host = facts.target?.host;
  const byHost =
    host === undefined ? undefined : providerOfHost(registry, host);
  if (byHost !== undefined && byHost !== 'self-hosted') named.add(byHost);
  if (named.size === 1) return [...named][0] ?? 'unknown';
  if (named.size > 1) return 'unknown';
  return byHost === 'self-hosted' ? 'self-hosted' : 'unknown';
}
