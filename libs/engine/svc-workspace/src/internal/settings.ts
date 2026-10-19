import {
  WORKSPACE_SETTING_DEFAULTS,
  WorkspaceSettingsSchema,
  type WorkspaceSettings,
} from '@app/contracts';
import type { WorkspaceRepository } from '@app/ports';

/** More than the engine has settings, so a retired key left in the store cannot push a live one out. */
const SETTINGS_WINDOW = 100;

/** One document per key, so two writes of different keys never overwrite each other. */
const SETTING_KEYS = Object.keys(
  WorkspaceSettingsSchema.shape,
) as readonly (keyof WorkspaceSettings)[];

/**
 * The effective settings: a stored value over the default. A stored value that no longer fits its
 * key's schema (the contract tightened) or a key the engine no longer knows is ignored, never
 * returned, so the answer always satisfies the contract.
 */
export async function readSettings(
  workspace: WorkspaceRepository,
  ownerId: string,
): Promise<WorkspaceSettings> {
  const stored = await workspace.listDocuments(
    ownerId,
    'setting',
    SETTINGS_WINDOW,
  );
  const effective: Record<string, unknown> = { ...WORKSPACE_SETTING_DEFAULTS };
  for (const { key, value } of stored) {
    const known = SETTING_KEYS.find((name) => name === key);
    if (known === undefined) continue;
    const parsed = WorkspaceSettingsSchema.shape[known].safeParse(value);
    if (parsed.success) effective[known] = parsed.data;
  }
  return WorkspaceSettingsSchema.parse(effective);
}
