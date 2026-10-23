// The input and output types of the effective-config resolver (DC-30, POL-01). Plain data in, plain
// data out: no API object, no connection, no clock. The management API's `effective_policy_definition`
// is not an input anywhere in this library and is rejected by `parseResolveInput`: it is the merged
// user and operator policy only, not the setting a queue has (fact sheet k.3).
import type { WarningId } from '@app/contracts';
import {
  QueueTypeSchema,
  SemVerSchema,
  type QueueType,
  type SemVer,
} from '@app/domain-model';
import type { Citation } from '@app/semantics';
import { z } from 'zod';

/** A value the resolver can report as effective. */
export type PolicyValue = number | string | boolean;

/** Where a value came from. */
export type Layer =
  | 'argument'
  | 'user-policy'
  | 'operator-policy'
  | 'broker-default';

/**
 * A policy that applies to the queue, already matched to it (see `matchPolicy` for the matching).
 * Definition values are `unknown`: a policy may hold keys the resolver does not look at (arrays,
 * objects), and those are never an error.
 */
export interface PolicyInput {
  readonly name: string;
  readonly definition: Readonly<Record<string, unknown>>;
}

export interface ResolveInput {
  readonly queueType: QueueType;
  /** The lowest broker version of the cluster; `null` when it could not be read. */
  readonly version: SemVer | null;
  /** The queue's `x-` arguments, as the broker reports them. */
  readonly args: Readonly<Record<string, unknown>>;
  readonly userPolicy: PolicyInput | null;
  readonly operatorPolicy: PolicyInput | null;
  /** Policy keys to report even when nothing sets them (their broker default, if the registry has one). */
  readonly keys?: readonly string[] | undefined;
}

export type EntryStatus =
  /** A value decided by an argument, a policy or both. */
  | 'effective'
  /** Nothing sets the key and the registry knows the broker default (`value: null` is "no limit"). */
  | 'default'
  /** Nothing sets the key, or the key has no effect here; `value` is null. */
  | 'unset'
  /** The registry cannot say (no row, no merge rule, unreadable version, sources disagree). */
  | 'unknown'
  /** An input is not usable with the rule (for example a string where a number is needed). */
  | 'invalid';

/**
 * What a leaf did: `deciding` (its value is the result and it won the rule), `compared` (the rule
 * looked at it and another value was chosen or equal), `overridden` (the rule gave the other
 * side precedence), `ignored` (it has no effect on this queue type or version), `unresolved` (the
 * entry is unknown or invalid, so nothing was decided).
 */
export type Role =
  | 'deciding'
  | 'compared'
  | 'overridden'
  | 'ignored'
  | 'unresolved';

export interface ProvenanceEntry {
  readonly layer: Layer;
  /** The argument name, the policy name, or `broker default`. */
  readonly name: string;
  readonly value: unknown;
  readonly role: Role;
}

export interface EffectiveWarning {
  readonly id: WarningId;
  readonly severity: 'info' | 'warn' | 'consent' | 'block';
  /** The i18n key of the text and its version (`i18n/en/effective-config.json`). */
  readonly textKey: string;
  readonly textVersion: number;
  /** The values for the `{{name}}` placeholders of the text. */
  readonly params: Readonly<Record<string, string>>;
  /** The citations of the registry row the warning comes from; empty for "the registry has no row". */
  readonly citations: readonly Citation[];
}

export interface EffectiveEntry {
  /** The policy key, `max-length`. */
  readonly key: string;
  /** The queue argument, `x-max-length`; null when the registry has no row that names it. */
  readonly argument: string | null;
  readonly status: EntryStatus;
  /** Set for `effective`; for `default` null means "no limit"; null otherwise. */
  readonly value: PolicyValue | null;
  /** Step 2, for example `min(arg, policy)`, `policy`, `arg`; null when nothing was decided. */
  readonly rule: string | null;
  /** Step 1, for example `negative-rule(user, operator)`; null when one policy layer or none. */
  readonly mergeRule: string | null;
  /** How far the registry row was read from the broker source; null when no row was used. */
  readonly basis: 'source-read' | 'extrapolated' | null;
  /** Every input and what it did. */
  readonly provenance: readonly ProvenanceEntry[];
  readonly warnings: readonly EffectiveWarning[];
}

/** Step 1 for one key. This is what the broker reports as `effective_policy_definition`: not effective. */
export type MergedEntry =
  | {
      readonly status: 'value';
      readonly value: unknown;
      /** `min(user, operator)` ... or null when only one layer sets the key. */
      readonly rule: string | null;
    }
  | {
      readonly status: 'unknown';
      readonly reason: 'no-merge-rule';
      readonly userValue: unknown;
      readonly operatorValue: unknown;
    }
  | {
      readonly status: 'invalid';
      readonly reason: string;
      readonly userValue: unknown;
      readonly operatorValue: unknown;
    };

export interface MergedPolicy {
  /** Always true: the merged policy is not the setting a queue has (an argument may win). */
  readonly notEffective: true;
  readonly entries: Readonly<Record<string, MergedEntry>>;
}

export interface EffectiveConfig {
  readonly queueType: QueueType;
  /** The version text the answer is for; null when it was unreadable. */
  readonly version: string | null;
  readonly entries: Readonly<Record<string, EffectiveEntry>>;
  readonly mergedPolicy: MergedPolicy;
  /** Argument names no registry row uses: reported, never silently dropped. */
  readonly unrecognisedArguments: readonly string[];
  /** Warnings about the whole answer (a tie between policies, a pattern that cannot be evaluated). */
  readonly warnings: readonly EffectiveWarning[];
}

const PolicyInputSchema = z.strictObject({
  name: z.string().min(1).max(255),
  definition: z.record(z.string(), z.unknown()),
});

/** The shape check for data that crosses a boundary. Strict: an unknown field is an error. */
export const ResolveInputSchema = z.strictObject({
  queueType: QueueTypeSchema,
  version: SemVerSchema.nullable(),
  args: z.record(z.string(), z.unknown()),
  userPolicy: PolicyInputSchema.nullable(),
  operatorPolicy: PolicyInputSchema.nullable(),
  keys: z.array(z.string().min(1)).max(256).optional(),
});

export type ParsedResolveInput =
  | { readonly ok: true; readonly input: ResolveInput }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Checks untrusted data against `ResolveInputSchema`. The management API's
 * `effective_policy_definition` (or any other unknown field) is a problem, not an input.
 */
export function parseResolveInput(data: unknown): ParsedResolveInput {
  const parsed = ResolveInputSchema.safeParse(data);
  if (parsed.success) return { ok: true, input: parsed.data };
  return {
    ok: false,
    problems: parsed.error.issues.map(
      (issue) =>
        `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
    ),
  };
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isPolicyValue(value: unknown): value is PolicyValue {
  return (
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    isFiniteNumber(value)
  );
}

const MAX_SHOWN = 120;

/** A value as the warning texts show it: short, and never an object dump. */
export function describeValue(value: unknown): string {
  if (value === undefined || value === null) return 'not set';
  if (typeof value === 'string') {
    return value.length > MAX_SHOWN ? `${value.slice(0, MAX_SHOWN)}...` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return Array.isArray(value) ? 'a list' : `a ${typeof value}`;
}
