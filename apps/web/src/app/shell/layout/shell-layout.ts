// The layout document of the shell: what the person arranged (sidebar, editor groups with tabs,
// bottom panel), as the UI stores it through `layouts.put` and reads through `layouts.get`. The
// engine keeps the document and never reads it (`LayoutDocumentSchema` is a bounded JSON object),
// so this file owns its shape, its version and its caps (OQ-535). Everything in it is bounded
// (I-6, I-7), and a stored document is never trusted: `parseLayout` never throws, falls back to the
// default and drops any tab whose address could leave the connection.
import { LAYOUT_MAX_CHARS } from '@app/contracts';
import { z } from 'zod';

export const SHELL_LAYOUT_VERSION = 1;

/** The caps of the document (OQ-535). All of them together stay inside `LAYOUT_MAX_CHARS`. */
export const SHELL_LAYOUT_LIMITS = Object.freeze({
  groups: 3,
  tabsPerGroup: 30,
  tabsTotal: 60,
  urlChars: 512,
  labelChars: 120,
});

const ID_CHARS = 64;
/** Pixel sizes in a stored document are bounded too; `fitLayout` clamps them to the viewport. */
const MAX_PIXELS = 4096;
const MAX_WEIGHT = 1_000_000;

/** An id of a registered shell entry, for example `explorer`. */
export type ActivityId = string;
export const PANEL_IDS = [
  'jobs',
  'receipts',
  'tap',
  'problems',
  'output',
] as const;
export type PanelId = (typeof PANEL_IDS)[number];

export interface TabRef {
  /** Stable within the document. */
  readonly id: string;
  /** Router URL under `/c/<cid>/`, no scheme, no host. Anything else is dropped on load. */
  readonly url: string;
  /** An i18n key for fixed tabs; entity tabs use `label` (engine data, rendered as text only). */
  readonly titleKey?: string | undefined;
  readonly label?: string | undefined;
}

export interface EditorGroup {
  /** Share of the editor area, positive. */
  readonly weight: number;
  readonly tabs: readonly TabRef[];
  readonly activeTab: string | null;
}

export interface ShellLayout {
  readonly version: typeof SHELL_LAYOUT_VERSION;
  readonly sidebar: {
    readonly visible: boolean;
    readonly width: number;
    readonly active: ActivityId;
  };
  readonly editor: {
    readonly orientation: 'row' | 'column';
    readonly groups: readonly EditorGroup[];
    readonly activeGroup: number;
  };
  readonly panel: {
    readonly visible: boolean;
    readonly height: number;
    readonly active: PanelId;
  };
}

const TabRefSchema = z.strictObject({
  id: z.string().min(1).max(ID_CHARS),
  url: z.string().min(1).max(SHELL_LAYOUT_LIMITS.urlChars),
  titleKey: z.string().min(1).max(SHELL_LAYOUT_LIMITS.labelChars).optional(),
  label: z.string().min(1).max(SHELL_LAYOUT_LIMITS.labelChars).optional(),
});

const EditorGroupSchema = z.strictObject({
  weight: z.number().positive().max(MAX_WEIGHT),
  tabs: z.array(TabRefSchema).max(SHELL_LAYOUT_LIMITS.tabsPerGroup),
  activeTab: z.string().min(1).max(ID_CHARS).nullable(),
});

/** Strict and explicit (ADR-003): an unknown key makes the document invalid, not ignored. */
export const ShellLayoutSchema: z.ZodType<ShellLayout> = z.strictObject({
  version: z.literal(SHELL_LAYOUT_VERSION),
  sidebar: z.strictObject({
    visible: z.boolean(),
    width: z.number().int().min(0).max(MAX_PIXELS),
    active: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  }),
  editor: z.strictObject({
    orientation: z.enum(['row', 'column']),
    groups: z.array(EditorGroupSchema).min(1).max(SHELL_LAYOUT_LIMITS.groups),
    activeGroup: z.number().int().min(0),
  }),
  panel: z.strictObject({
    visible: z.boolean(),
    height: z.number().int().min(0).max(MAX_PIXELS),
    active: z.enum(PANEL_IDS),
  }),
});

/**
 * Why a stored layout was not used as it was. `absent` is the quiet one (nothing was saved yet);
 * `load-failed` is the engine not answering `layouts.get`, in which case nothing is written until
 * the person changes the layout.
 */
export type LayoutNotice =
  | 'absent'
  | 'invalid'
  | 'newer-version'
  | 'tabs-dropped'
  | 'over-limit'
  | 'load-failed';

export const DEFAULT_SIDEBAR_WIDTH = 260;
export const DEFAULT_PANEL_HEIGHT = 200;

export function defaultLayout(): ShellLayout {
  return {
    version: SHELL_LAYOUT_VERSION,
    sidebar: {
      visible: true,
      width: DEFAULT_SIDEBAR_WIDTH,
      active: 'explorer',
    },
    editor: {
      orientation: 'row',
      groups: [{ weight: 1, tabs: [], activeTab: null }],
      activeGroup: 0,
    },
    panel: { visible: false, height: DEFAULT_PANEL_HEIGHT, active: 'jobs' },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const ORIGIN = 'http://shell.invalid';

/**
 * True for an address inside the connection: `/c/<cid>/...` as a path, nothing else. The check is
 * made on the text and again on what the URL parser makes of it, so `..` segments, a backslash, a
 * scheme or a protocol-relative form cannot lead out of `/c/<cid>/` (AC-6).
 */
export function isSafeTabUrl(url: unknown, cid: string): url is string {
  if (typeof url !== 'string' || url.length === 0) return false;
  if (url.length > SHELL_LAYOUT_LIMITS.urlChars) return false;
  if (hasControlChar(url) || url.includes('\\')) return false;
  const prefix = `/c/${cid}/`;
  if (!url.startsWith(prefix)) return false;
  try {
    const parsed = new URL(url, ORIGIN);
    return parsed.origin === ORIGIN && parsed.pathname.startsWith(prefix);
  } catch {
    return false;
  }
}

function usableTab(
  value: unknown,
  cid: string,
  seen: Set<string>,
): TabRef | null {
  const parsed = TabRefSchema.safeParse(value);
  if (!parsed.success) return null;
  const tab = parsed.data;
  if (seen.has(tab.id) || !isSafeTabUrl(tab.url, cid)) return null;
  if (tab.titleKey === undefined && tab.label === undefined) return null;
  if (hasControlChar(tab.id) || hasControlChar(tab.label ?? '')) return null;
  if (hasControlChar(tab.titleKey ?? '')) return null;
  seen.add(tab.id);
  return tab;
}

function groupsOf(raw: Record<string, unknown>): unknown[] | null {
  const editor = raw.editor;
  if (!isRecord(editor) || !Array.isArray(editor.groups)) return null;
  return editor.groups as unknown[];
}

function tabsOf(group: unknown): unknown[] | null {
  return isRecord(group) && Array.isArray(group.tabs)
    ? (group.tabs as unknown[])
    : null;
}

/** True when a stored document is over a cap, before any of it is looked at. */
function overLimit(groups: readonly unknown[]): boolean {
  if (groups.length > SHELL_LAYOUT_LIMITS.groups) return true;
  let total = 0;
  for (const group of groups) {
    const tabs = tabsOf(group);
    if (tabs === null) continue;
    if (tabs.length > SHELL_LAYOUT_LIMITS.tabsPerGroup) return true;
    total += tabs.length;
  }
  return total > SHELL_LAYOUT_LIMITS.tabsTotal;
}

/** Keeps only the usable tabs; counts what was dropped. */
function withoutUnusableTabs(
  raw: Record<string, unknown>,
  groups: readonly unknown[],
  cid: string,
): { readonly candidate: unknown; readonly dropped: number } {
  const seen = new Set<string>();
  let dropped = 0;
  const cleaned = groups.map((group) => {
    const tabs = tabsOf(group);
    if (tabs === null || !isRecord(group)) return group;
    const kept = tabs.flatMap((tab) => {
      const usable = usableTab(tab, cid, seen);
      if (usable === null) dropped += 1;
      return usable === null ? [] : [usable];
    });
    const active = group.activeTab;
    const activeStays = kept.some((tab) => tab.id === active);
    return {
      ...group,
      tabs: kept,
      activeTab: activeStays ? active : (kept[0]?.id ?? null),
    };
  });
  return {
    candidate: {
      ...raw,
      editor: { ...(raw.editor as object), groups: cleaned },
    },
    dropped,
  };
}

/** A stored document is `unknown`: this turns it into a layout, never throwing (AC-6). */
export function parseLayout(
  raw: unknown,
  cid: string,
): { layout: ShellLayout; notice: LayoutNotice | null } {
  const fallback = (notice: LayoutNotice) => ({
    layout: defaultLayout(),
    notice,
  });
  if (raw === null || raw === undefined) return fallback('absent');
  if (!isRecord(raw)) return fallback('invalid');
  const version = raw.version;
  if (typeof version === 'number' && version > SHELL_LAYOUT_VERSION) {
    return fallback('newer-version');
  }
  const groups = groupsOf(raw);
  if (groups === null) return fallback('invalid');
  if (overLimit(groups)) return fallback('over-limit');
  const { candidate, dropped } = withoutUnusableTabs(raw, groups, cid);
  const parsed = ShellLayoutSchema.safeParse(candidate);
  if (!parsed.success) return fallback('invalid');
  const layout = clampActiveGroup(parsed.data);
  return { layout, notice: dropped > 0 ? 'tabs-dropped' : null };
}

function clampActiveGroup(layout: ShellLayout): ShellLayout {
  const last = layout.editor.groups.length - 1;
  return layout.editor.activeGroup <= last
    ? layout
    : { ...layout, editor: { ...layout.editor, activeGroup: last } };
}

/** The characters of the document as the engine counts them (`LAYOUT_MAX_CHARS`). */
export function layoutChars(layout: ShellLayout): number {
  return JSON.stringify(layout).length;
}

export const withinContractSize = (layout: ShellLayout): boolean =>
  layoutChars(layout) <= LAYOUT_MAX_CHARS;
