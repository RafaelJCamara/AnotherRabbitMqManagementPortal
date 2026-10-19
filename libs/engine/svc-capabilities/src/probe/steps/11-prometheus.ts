// Step 11, Prometheus: where each node's metrics endpoint is, found in the order the fact sheet
// gives: what the broker says it listens on (`http/prometheus` in the overview), then the provider's
// documented ports, then the default port when the plugin is known to be on. Nothing is scraped here.
// With statistics off RabbitMQ reports no listeners at all (golden fixtures), so that case falls
// through to the provider and the default.
import { isRabbitMqFamily, productOf, providerOf } from '../identify';
import type { Facts, ProbeEnv, ProbeStep } from '../types';

const DEFAULT_PORT = 15692;
const MAX_ENDPOINTS = 16;
const PROMETHEUS_LISTENER = /^(https?)\/prometheus$/;

type Endpoint = NonNullable<Facts['prometheus']>[number];

const hostPart = (host: string): string =>
  host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

/** The endpoints the facts support; empty when the product is not RabbitMQ or the host is unknown. */
export function derivePrometheus(env: ProbeEnv, facts: Facts): Endpoint[] {
  const product = productOf(facts);
  const host = facts.target?.host;
  const first = facts.overviews[0];
  if (!isRabbitMqFamily(product) || host === undefined || first === undefined) {
    return [];
  }
  const answering = first.node ?? 'unknown';
  const out: Endpoint[] = [];

  for (const listener of first.overview.listeners ?? []) {
    const match = PROMETHEUS_LISTENER.exec(listener.protocol);
    if (match === null) continue;
    out.push({
      node: listener.node ?? answering,
      url: `${match[1] ?? 'http'}://${hostPart(host)}:${String(listener.port)}/metrics`,
      source: 'listener',
    });
  }
  if (out.length > 0) return out.slice(0, MAX_ENDPOINTS);

  const provider = providerOf(env.registry, facts);
  const preset = env.registry.providerPreset({ provider, product }, null);
  // A provider that blocks Prometheus has no endpoint to find: a guess would only mislead.
  if (preset.support.prometheus === 'blocked') return [];
  const scheme = facts.target?.managementTls === true ? 'https' : 'http';
  for (const port of preset.prometheus.ports ?? []) {
    out.push({
      node: answering,
      url: `${scheme}://${hostPart(host)}:${String(port)}/metrics`,
      source: 'provider',
    });
  }
  if (out.length > 0) return out.slice(0, MAX_ENDPOINTS);

  const pluginOn = (facts.nodes ?? []).some((node) =>
    node.plugins?.includes('rabbitmq_prometheus'),
  );
  if (pluginOn) {
    out.push({
      node: answering,
      url: `${scheme}://${hostPart(host)}:${String(DEFAULT_PORT)}/metrics`,
      source: 'default',
    });
  }
  return out;
}

export const prometheusStep: ProbeStep = {
  id: 'prometheus',
  run(env, facts) {
    facts.prometheus = derivePrometheus(env, facts);
    return Promise.resolve(
      facts.prometheus.length === 0
        ? { status: 'unavailable', detail: 'no metrics endpoint was found' }
        : {
            status: 'ok',
            detail: `${String(facts.prometheus.length)} endpoint(s), from ${facts.prometheus[0]?.source ?? 'nothing'}`,
          },
    );
  },
};
