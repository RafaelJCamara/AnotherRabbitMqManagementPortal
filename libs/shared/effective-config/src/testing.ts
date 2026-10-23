// Helpers for the specs of this library (not part of its public API).
import { parseSemVer, type QueueType, type SemVer } from '@app/domain-model';
import type {
  EffectiveConfig,
  EffectiveEntry,
  PolicyInput,
  ResolveInput,
} from './model.ts';

export function v(text: string): SemVer {
  const parsed = parseSemVer(text);
  if (parsed === null) throw new Error(`test setup: ${text} does not parse`);
  return parsed;
}

export function policy(
  name: string,
  definition: Record<string, unknown>,
): PolicyInput {
  return { name, definition };
}

export interface Scenario {
  readonly queueType?: QueueType;
  readonly version?: string | null;
  readonly args?: Record<string, unknown>;
  readonly user?: Record<string, unknown> | null;
  readonly operator?: Record<string, unknown> | null;
  readonly keys?: readonly string[];
}

/** A ResolveInput with the policies named `user-policy` and `operator-policy`. */
export function input(scenario: Scenario = {}): ResolveInput {
  const version = scenario.version === undefined ? '4.3.6' : scenario.version;
  return {
    queueType: scenario.queueType ?? 'quorum',
    version: version === null ? null : v(version),
    args: scenario.args ?? {},
    userPolicy:
      scenario.user === undefined || scenario.user === null
        ? null
        : policy('user-policy', scenario.user),
    operatorPolicy:
      scenario.operator === undefined || scenario.operator === null
        ? null
        : policy('operator-policy', scenario.operator),
    ...(scenario.keys === undefined ? {} : { keys: scenario.keys }),
  };
}

export function entryOf(result: EffectiveConfig, key: string): EffectiveEntry {
  const found = Object.hasOwn(result.entries, key)
    ? result.entries[key]
    : undefined;
  if (found === undefined) throw new Error(`no entry for ${key}`);
  return found;
}

/** A value deeply frozen, so that a function that writes to its input throws. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
