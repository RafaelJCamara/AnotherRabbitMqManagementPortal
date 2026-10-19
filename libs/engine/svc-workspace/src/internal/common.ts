// What every workspace action shares. Workspace commands change only the caller's own UI state,
// so they have no preview worth reviewing: `plan()` states what will change and reads nothing,
// and `revalidate()` has nothing to go stale.
import { ViewDefinitionSchema, type SavedView } from '@app/contracts';
import { AppError, type PlanDraft } from '@app/kernel';
import type { Principal, SavedViewRecord } from '@app/ports';

/** The workspace is the caller's own: every row is keyed by the principal that made the call. */
export function ownerOf(principal: Principal): string {
  return principal.id;
}

/** A stored view as the contract describes it. A row that does not fit is an engine fault. */
export function toSavedView(record: SavedViewRecord): SavedView {
  const definition = ViewDefinitionSchema.safeParse(record.definition);
  if (!definition.success) {
    throw new AppError('INTERNAL', {
      detail: `The stored view ${record.id} does not fit the contract.`,
    });
  }
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    definition: definition.data,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** A plan with no gates, warnings or consents: a draft of what the command will store. */
export function plainPlan<P>(preview: P): () => Promise<PlanDraft<P>> {
  return () =>
    Promise.resolve({
      preview,
      gates: [],
      warnings: [],
      consentsRequired: [],
    });
}

/** The TOCTOU re-check of a command that depends on nothing it read. */
export const alwaysValid = (): Promise<'valid'> => Promise.resolve('valid');
