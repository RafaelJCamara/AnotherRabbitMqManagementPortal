// Who runs the broker, from data: the registry's provider presets name each provider's host
// patterns (fact sheet j.2 step 2) and the objects it owns (step 9). Nothing here knows a provider.
import { ProviderSchema, type Provider } from '@app/domain-model';
import type { BrokerSemanticsRegistry, ResolvedPreset } from '@app/semantics';

/** The preset of every provider, in `ProviderSchema` order (self-hosted first, `unknown` last). */
export function allProviderPresets(
  registry: BrokerSemanticsRegistry,
): readonly { id: Provider; preset: ResolvedPreset }[] {
  return ProviderSchema.options.map((id) => ({
    id,
    preset: registry.providerPreset(
      { provider: id, product: 'rabbitmq' },
      null,
    ),
  }));
}

const escape = (text: string): string =>
  text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** `*` is one or more characters, as the presets document it. Case does not matter in a host name. */
export function globMatches(glob: string, text: string): boolean {
  const source = glob.split('*').map(escape).join('.+');
  return new RegExp(`^${source}$`, 'i').test(text);
}

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?)$/i;

/**
 * The provider a host name says, or undefined. A loopback address is a broker on this machine. When
 * two providers share a pattern (both CloudAMQP plans do) the first in `ProviderSchema` order wins,
 * and that is the shared plan, whose preset is the weaker one: a tie never grants more.
 */
export function providerOfHost(
  registry: BrokerSemanticsRegistry,
  host: string,
): Provider | undefined {
  if (LOOPBACK.test(host)) return 'self-hosted';
  return allProviderPresets(registry).find(({ preset }) =>
    preset.hostPatterns.some((glob) => globMatches(glob, host)),
  )?.id;
}
