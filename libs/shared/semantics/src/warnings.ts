// The W-* warning registry (DC-47): each warning has a severity and a versioned text key, so that
// a receipt can say which wording the user saw. The texts live in i18n files (M0-13); this module
// only resolves ids.
import {
  WarningRefSchema,
  type WarningId,
  type WarningRef,
} from '@app/contracts';
import { RegistryDataError, SemanticsGapError } from './schema.ts';

export { WarningRefSchema as WarningDefSchema };

/** Builds the lookup. Throws RegistryDataError when an id appears twice. */
export function buildWarnings(
  defs: readonly WarningRef[],
): (id: WarningId) => WarningRef {
  const byId = new Map<string, WarningRef>();
  for (const def of defs) {
    if (byId.has(def.id)) {
      throw new RegistryDataError([`warning ${def.id} is defined twice`]);
    }
    byId.set(def.id, def);
  }
  return (id) => {
    const found = byId.get(id);
    if (found === undefined) {
      throw new SemanticsGapError({ table: 'warning', id });
    }
    return found;
  };
}
