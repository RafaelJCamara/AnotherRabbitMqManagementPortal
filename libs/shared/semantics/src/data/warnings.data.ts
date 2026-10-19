// The 16 W-* warnings of fact sheet b.8 (step 5): an id, a severity and a versioned text key. The
// wording lives in `libs/shared/semantics/i18n/en/warnings.json` under `<id>.v<textVersion>`, so a
// receipt that stores `{id, textVersion}` can always show the words the user saw. Changing a text
// means a new version and a new key; the old key stays.
//
// Severity says what the planner does with the warning: `info` and `warn` are shown, `consent`
// must be confirmed before the plan can run, `block` stops the plan until the cause is fixed.
import type { WarningRef } from '@app/contracts';

const warning = (
  id: WarningRef['id'],
  severity: WarningRef['severity'],
): WarningRef => ({
  id,
  severity,
  textKey: `warnings.${id}.v1`,
  textVersion: 1,
});

export const warnings: readonly WarningRef[] = [
  // Quorum queue peeks: the delivery limit and the counters (b.2, b.4, b.8).
  warning('W-BUDGET', 'consent'),
  warning('W-313', 'consent'),
  warning('W-TAIL', 'warn'),
  warning('W-OVERLIMIT', 'block'),
  warning('W-DELAY', 'consent'),
  warning('W-REDELIVERED', 'info'),
  // Holding messages and what can happen to them while held (b.3, b.7).
  warning('W-HOLD', 'warn'),
  warning('W-DROPHEAD', 'consent'),
  warning('W-TTL', 'warn'),
  warning('W-CRASH', 'info'),
  // Consumers and ownership (b.7).
  warning('W-SAC-CQ', 'warn'),
  warning('W-SAC-QQ', 'consent'),
  warning('W-EXCLUSIVE', 'block'),
  // The broker profile (b.2 limit configuration, b.8 step 1) and streams (b.6).
  warning('W-UPGRADED', 'warn'),
  warning('W-MIXED', 'warn'),
  warning('W-STREAM', 'info'),
];
