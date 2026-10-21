// The hazard ids the page has a sentence for (`explorer.hazard.<id>`, M0-54, Q-22). The profile lists
// the hazards that apply to a broker and the registry decides that (I-3); this table is only the
// words. An id that is not in it is shown as the id with a generic sentence, never hidden.
export const KNOWN_HAZARDS: readonly string[] = [
  'stats-off-policy-fields-missing',
];

export function isKnownHazard(id: string): boolean {
  return KNOWN_HAZARDS.includes(id);
}
