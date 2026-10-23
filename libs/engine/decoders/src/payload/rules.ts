// Per-queue rules (blueprint 11: "selection by content_type, content_encoding and per-queue
// rules"). A rule list is user data, so a pattern is exact or has at most one `*`: no regular
// expression, nothing that can backtrack (ADR-022 tier 2). The first matching rule wins.
import type { FormatCodecId } from '../codecs/types.ts';

export interface PayloadRule {
  /** A queue name, or a pattern with one `*` (`orders.*`, `*.dlq`, `a*b`). */
  readonly queue: string;
  /** Force this format codec. */
  readonly codec?: FormatCodecId;
  /** Replaces the message's `content-encoding` (a comma-separated list). */
  readonly encoding?: string;
  /** Replaces the charset of the content type. */
  readonly charset?: string;
  /** Show the bytes as hex or base64 whatever they are. */
  readonly view?: 'hex' | 'base64';
}

export const MAX_RULES = 64;
export const MAX_PATTERN = 256;

export function queueMatches(pattern: string, queue: string): boolean {
  if (pattern.length > MAX_PATTERN) return false;
  const star = pattern.indexOf('*');
  if (star === -1) return pattern === queue;
  if (pattern.includes('*', star + 1)) return false;
  const head = pattern.slice(0, star);
  const tail = pattern.slice(star + 1);
  return (
    queue.length >= head.length + tail.length &&
    queue.startsWith(head) &&
    queue.endsWith(tail)
  );
}

export function matchRule(
  rules: readonly PayloadRule[] | undefined,
  queue: string | undefined,
): PayloadRule | undefined {
  if (!Array.isArray(rules) || typeof queue !== 'string') return undefined;
  const limit = Math.min(rules.length, MAX_RULES);
  for (let i = 0; i < limit; i++) {
    const rule: unknown = rules[i];
    if (
      typeof rule === 'object' &&
      rule !== null &&
      typeof (rule as PayloadRule).queue === 'string' &&
      queueMatches((rule as PayloadRule).queue, queue)
    ) {
      return rule as PayloadRule;
    }
  }
  return undefined;
}
