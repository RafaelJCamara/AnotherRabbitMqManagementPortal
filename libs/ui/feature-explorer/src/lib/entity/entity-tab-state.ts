// Whether a tab of an entity page can be used, and if not why (M1-42, R2, DC-31). The page renders the gate the
// engine sent for the tab's feature and never computes authorisation: a gate is open only for
// `enabled === true`, any other value or shape is closed, and a profile that is not known closes every gated
// tab. A tab that is not built in this version says so; a closed gate is explained with the engine's reason and
// source as sent.
import type { EntityTabSpec } from '@app/explorer-model';

import { capabilityRows } from '../overview/capability-model';
import type { Translate } from '../translate';

export type TabUnavailable =
  /** The content of the tab is built by a later work package. */
  | { readonly why: 'later' }
  /** The engine closed the gate; its reason and source as sent (`null` when it sent none). */
  | {
      readonly why: 'gate';
      readonly reason: string | null;
      readonly source: string | null;
    }
  /** The capabilities of the connection are not known, so a gated tab stays closed. */
  | { readonly why: 'unknown-gate' };

/** `null` when the tab can be used. `profile` is what `profile.get` sent, as received. */
export function tabUnavailable(
  spec: EntityTabSpec,
  profile: unknown,
): TabUnavailable | null {
  if (spec.gate !== null) {
    const rows = capabilityRows(profile);
    if (rows === null) return { why: 'unknown-gate' };
    const row = rows.find((candidate) => candidate.id === spec.gate);
    // A gate the engine did not send is not an open one.
    if (row === undefined) return { why: 'unknown-gate' };
    if (row.state === 'closed') {
      return { why: 'gate', reason: row.reason, source: row.source };
    }
  }
  return spec.built ? null : { why: 'later' };
}

/** The sentence that says why a tab cannot be used; the engine's reason and source are put in as sent. */
export function unavailableText(why: TabUnavailable, t: Translate): string {
  switch (why.why) {
    case 'later':
      return t('explorer.entity.tabReason.later');
    case 'unknown-gate':
      return t('explorer.entity.tabReason.unknownGate');
    case 'gate': {
      const reason =
        why.reason === null
          ? t('explorer.entity.tabReason.gateNoReason')
          : t('explorer.entity.tabReason.gate', { reason: why.reason });
      return why.source === null
        ? reason
        : `${reason} ${t('explorer.entity.tabReason.source', { source: why.source })}`;
    }
  }
}
