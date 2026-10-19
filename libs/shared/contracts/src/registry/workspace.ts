// The shapes the workspace actions share (M0-47): what the UI remembers for a person. Everything
// here is bounded (I-6, I-7): a document has a size cap, a person has a cap on views, layouts and
// keybindings, and views come in windows.
import { z } from 'zod';

/** The most views one person keeps. */
export const VIEWS_PER_OWNER_MAX = 500;
/** The most views one `views.list` call returns. */
export const VIEWS_PAGE_MAX = 200;
/** The most layouts (one per connection profile) one person keeps. */
export const LAYOUTS_PER_OWNER_MAX = 200;
/** The most keybinding overrides one person keeps. */
export const KEYBINDINGS_MAX = 500;
/** Longest JSON text of a view definition, in UTF-16 code units. */
export const VIEW_DEFINITION_MAX_CHARS = 16_384;
/** Longest JSON text of a layout, in UTF-16 code units. */
export const LAYOUT_MAX_CHARS = 65_536;

/**
 * A JSON object the UI owns (a layout, a view definition). The engine stores it and never reads
 * it, so its values are `unknown` (the spec says `{}`): `z.json()` is recursive, which the spec
 * emitter does not support yet.
 */
function boundedJsonObject(maxChars: number) {
  return z
    .record(z.string(), z.unknown())
    .refine((value) => JSON.stringify(value).length <= maxChars, {
      error: `The document is larger than ${String(maxChars)} characters of JSON.`,
    });
}

export const ViewDefinitionSchema = boundedJsonObject(
  VIEW_DEFINITION_MAX_CHARS,
);
export const LayoutDocumentSchema = boundedJsonObject(LAYOUT_MAX_CHARS);

/** Which grid a view is for (`queues`, `exchanges`...). */
export const ViewKindSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);

export const SavedViewSchema = z.strictObject({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  kind: ViewKindSchema,
  definition: ViewDefinitionSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type SavedView = z.infer<typeof SavedViewSchema>;

/**
 * The settings the engine knows. A key that is not here is refused: `strictObject` is what turns an
 * unknown key into VALIDATION_FAILED. Adding a setting is adding a key here (and its default).
 * The theme and the density are not here: the UI keeps them in the browser (OQ-348).
 */
export const WorkspaceSettingsSchema = z.strictObject({
  locale: z
    .string()
    .max(35)
    .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
  timeDisplay: z.enum(['local', 'utc']),
  defaultPageSize: z.number().int().min(10).max(200),
});
export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>;

/** What a person who never changed a setting has. */
export const WORKSPACE_SETTING_DEFAULTS: WorkspaceSettings = Object.freeze({
  locale: 'en',
  timeDisplay: 'local',
  defaultPageSize: 50,
});

/** A command id of the UI's command registry (`queues.purge`, `go-to.explorer`). */
export const KeybindingCommandIdSchema = z
  .string()
  .regex(/^[a-z][A-Za-z0-9.-]{0,99}$/);

/**
 * Overrides of the default keybindings: a command id to a chord, or to `null` for "unbound". The
 * chord's syntax belongs to the UI's keybinding service, so only its length is bounded here.
 */
export const KeybindingOverridesSchema = z
  .record(KeybindingCommandIdSchema, z.string().min(1).max(64).nullable())
  .refine((value) => Object.keys(value).length <= KEYBINDINGS_MAX, {
    error: `At most ${String(KEYBINDINGS_MAX)} keybindings can be overridden.`,
  });
export type KeybindingOverrides = z.infer<typeof KeybindingOverridesSchema>;
