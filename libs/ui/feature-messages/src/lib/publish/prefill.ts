// The only parts of the address the studio reads: `vhost`, `exchange` and `routingKey` (R7). Any other parameter
// is ignored, and a value over the contract's text bound is refused by name, never cut.
import { PUBLISH_LIMITS } from '@app/contracts';

export const PREFILL_PARAMS = ['vhost', 'exchange', 'routingKey'] as const;
export type PrefillParam = (typeof PREFILL_PARAMS)[number];

export interface Prefill {
  readonly patch: Partial<Record<PrefillParam, string>>;
  readonly refused: readonly PrefillParam[];
}

export function prefillFromQuery(
  get: (name: string) => string | null,
): Prefill {
  const patch: Partial<Record<PrefillParam, string>> = {};
  const refused: PrefillParam[] = [];
  for (const name of PREFILL_PARAMS) {
    const value = get(name);
    if (value === null) continue;
    if (value.length > PUBLISH_LIMITS.textMax) refused.push(name);
    else patch[name] = value;
  }
  return { patch, refused };
}
