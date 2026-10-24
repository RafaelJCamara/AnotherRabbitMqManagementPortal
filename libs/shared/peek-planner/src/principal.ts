// Who is asking (R11, OQ-1426). DC-09 forbids letting the broker handle a doomed message for AI
// and unattended runs; A-1 and A-2 block them elsewhere. A principal is human interactive only
// when it, and everyone it acts for, is a person's session or token on a screen or a command line
// and is not unattended. Anything else is non-human, including an MCP client acting for a person.
import type { PeekPrincipal } from './types.ts';

const HUMAN_KINDS: ReadonlySet<PeekPrincipal['kind']> = new Set([
  'desktop-user',
  'local-token',
  'team-user',
  'api-token',
]);
const HUMAN_SURFACES: ReadonlySet<PeekPrincipal['surface']> = new Set([
  'ui',
  'cli',
]);

/** Longest delegation chain read; a longer one is not a person (the kernel allows four). */
const MAX_CHAIN = 4;

export function isHumanInteractive(principal: PeekPrincipal): boolean {
  let current: PeekPrincipal | undefined = principal;
  for (let depth = 0; current !== undefined; depth += 1) {
    if (depth >= MAX_CHAIN) return false;
    if (
      current.unattended ||
      !HUMAN_KINDS.has(current.kind) ||
      !HUMAN_SURFACES.has(current.surface)
    ) {
      return false;
    }
    current = current.onBehalfOf;
  }
  return true;
}
