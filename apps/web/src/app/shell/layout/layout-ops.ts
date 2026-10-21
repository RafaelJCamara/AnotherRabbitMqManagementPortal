// The changes a person can make to the layout, as pure functions. An operation that would break a
// cap is refused with a reason, never applied in part and never by evicting something else: the
// shell shows the refusal (AC-8, I-6, I-13).
import {
  SHELL_LAYOUT_LIMITS,
  isSafeTabUrl,
  withinContractSize,
  type ActivityId,
  type EditorGroup,
  type PanelId,
  type ShellLayout,
  type TabRef,
} from './shell-layout';

export type LayoutRefusal =
  | 'groups'
  | 'tabs-per-group'
  | 'tabs-total'
  | 'url-too-long'
  | 'label-too-long'
  | 'unsafe-url'
  | 'document-too-large';

export type LayoutResult =
  | { readonly ok: true; readonly layout: ShellLayout }
  | { readonly ok: false; readonly refusal: LayoutRefusal };

const done = (layout: ShellLayout): LayoutResult =>
  withinContractSize(layout)
    ? { ok: true, layout }
    : { ok: false, refusal: 'document-too-large' };

const refuse = (refusal: LayoutRefusal): LayoutResult => ({
  ok: false,
  refusal,
});

export interface NewTab {
  readonly url: string;
  readonly titleKey?: string | undefined;
  readonly label?: string | undefined;
}

export const tabCount = (layout: ShellLayout): number =>
  layout.editor.groups.reduce((sum, group) => sum + group.tabs.length, 0);

function nextTabId(layout: ShellLayout): string {
  let highest = 0;
  for (const group of layout.editor.groups) {
    for (const tab of group.tabs) {
      const match = /^t(\d+)$/.exec(tab.id);
      if (match?.[1] !== undefined) {
        highest = Math.max(highest, Number(match[1]));
      }
    }
  }
  return `t${String(highest + 1)}`;
}

function replaceGroup(
  layout: ShellLayout,
  index: number,
  group: EditorGroup,
): ShellLayout {
  return {
    ...layout,
    editor: {
      ...layout.editor,
      groups: layout.editor.groups.map((g, i) => (i === index ? group : g)),
      activeGroup: index,
    },
  };
}

/**
 * Opens a tab in a group (the active one by default). A tab for an address the group already has
 * is activated instead of duplicated. `cid` is the connection the address must belong to.
 */
export function openTab(
  layout: ShellLayout,
  cid: string,
  tab: NewTab,
  groupIndex: number = layout.editor.activeGroup,
): LayoutResult {
  const group = layout.editor.groups[groupIndex];
  if (group === undefined) return refuse('groups');
  if (tab.url.length > SHELL_LAYOUT_LIMITS.urlChars) {
    return refuse('url-too-long');
  }
  if (
    (tab.label?.length ?? 0) > SHELL_LAYOUT_LIMITS.labelChars ||
    (tab.titleKey?.length ?? 0) > SHELL_LAYOUT_LIMITS.labelChars
  ) {
    return refuse('label-too-long');
  }
  if (
    !isSafeTabUrl(tab.url, cid) ||
    (tab.label === undefined && tab.titleKey === undefined)
  ) {
    return refuse('unsafe-url');
  }
  const existing = group.tabs.find((t) => t.url === tab.url);
  if (existing !== undefined) {
    return done(
      replaceGroup(layout, groupIndex, { ...group, activeTab: existing.id }),
    );
  }
  if (group.tabs.length >= SHELL_LAYOUT_LIMITS.tabsPerGroup) {
    return refuse('tabs-per-group');
  }
  if (tabCount(layout) >= SHELL_LAYOUT_LIMITS.tabsTotal) {
    return refuse('tabs-total');
  }
  const created: TabRef = {
    id: nextTabId(layout),
    url: tab.url,
    ...(tab.titleKey === undefined ? {} : { titleKey: tab.titleKey }),
    ...(tab.label === undefined ? {} : { label: tab.label }),
  };
  return done(
    replaceGroup(layout, groupIndex, {
      ...group,
      tabs: [...group.tabs, created],
      activeTab: created.id,
    }),
  );
}

/** Adds an empty editor group next to the others, with an equal share of the area. */
export function splitEditor(layout: ShellLayout): LayoutResult {
  const { groups } = layout.editor;
  if (groups.length >= SHELL_LAYOUT_LIMITS.groups) return refuse('groups');
  const total = groups.reduce((sum, group) => sum + group.weight, 0);
  const added: EditorGroup = {
    weight: total / groups.length,
    tabs: [],
    activeTab: null,
  };
  return done({
    ...layout,
    editor: {
      ...layout.editor,
      groups: [...groups, added],
      activeGroup: groups.length,
    },
  });
}

export const setSidebarWidth = (
  layout: ShellLayout,
  width: number,
): ShellLayout => ({
  ...layout,
  sidebar: { ...layout.sidebar, width: Math.round(width) },
});

export const setPanelHeight = (
  layout: ShellLayout,
  height: number,
): ShellLayout => ({
  ...layout,
  panel: { ...layout.panel, height: Math.round(height) },
});

export const setSidebarVisible = (
  layout: ShellLayout,
  visible: boolean,
): ShellLayout => ({ ...layout, sidebar: { ...layout.sidebar, visible } });

/** Shows an activity in the sidebar and makes sure the sidebar is open. */
export const showActivity = (
  layout: ShellLayout,
  active: ActivityId,
): ShellLayout => ({
  ...layout,
  sidebar: { ...layout.sidebar, active, visible: true },
});

export const setPanelVisible = (
  layout: ShellLayout,
  visible: boolean,
): ShellLayout => ({ ...layout, panel: { ...layout.panel, visible } });

export const showPanelTab = (
  layout: ShellLayout,
  active: PanelId,
): ShellLayout => ({
  ...layout,
  panel: { ...layout.panel, active },
});
