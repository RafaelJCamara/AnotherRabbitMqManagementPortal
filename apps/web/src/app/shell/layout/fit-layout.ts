// The sizing rules of the shell for a viewport, as pure functions (AC-9). A stored layout can hold
// sizes from a bigger window; `fitLayout` clamps them so the activity bar, sidebar, editor area,
// panel and status bar fit the viewport and the editor keeps its minimum. The stylesheet clips
// what is left (`min-width: 0`, `overflow: hidden` on the grid cells), so the page never gets a
// horizontal scroll bar, even below the sizes these rules can honour.
import type { ShellLayout } from './shell-layout';

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** Pixel sizes of the frame. The activity bar and status bar sizes match shell.css. */
export const FIT = Object.freeze({
  activityBar: 72,
  statusBar: 28,
  sidebarMin: 160,
  sidebarMax: 600,
  panelMin: 80,
  panelMax: 600,
  editorMinWidth: 240,
  editorMinHeight: 120,
  groupMinWidth: 160,
  groupMinHeight: 96,
});

export interface Bounds {
  readonly min: number;
  readonly max: number;
}

const clamp = (value: number, { min, max }: Bounds): number =>
  Math.min(max, Math.max(min, value));

function editorMinWidth(layout: ShellLayout): number {
  const groups = layout.editor.groups.length;
  return layout.editor.orientation === 'row'
    ? Math.max(FIT.editorMinWidth, groups * FIT.groupMinWidth)
    : Math.max(FIT.editorMinWidth, FIT.groupMinWidth);
}

function editorMinHeight(layout: ShellLayout): number {
  const groups = layout.editor.groups.length;
  return layout.editor.orientation === 'column'
    ? Math.max(FIT.editorMinHeight, groups * FIT.groupMinHeight)
    : FIT.editorMinHeight;
}

/** The widths the sidebar may have, so the editor keeps its minimum. */
export function sidebarBounds(layout: ShellLayout, viewport: Viewport): Bounds {
  const room = viewport.width - FIT.activityBar - editorMinWidth(layout);
  return {
    min: FIT.sidebarMin,
    max: Math.max(FIT.sidebarMin, Math.min(FIT.sidebarMax, room)),
  };
}

/** The heights the panel may have, so the editor keeps its minimum. */
export function panelBounds(layout: ShellLayout, viewport: Viewport): Bounds {
  const room = viewport.height - FIT.statusBar - editorMinHeight(layout);
  return {
    min: FIT.panelMin,
    max: Math.max(FIT.panelMin, Math.min(FIT.panelMax, room)),
  };
}

/**
 * Pixel sizes for weights over a span, none below `min`. The weights stay as they are when they
 * already fit (so the result is idempotent and keeps the proportions); otherwise the groups that
 * are too small get `min` and the rest share what is left in proportion.
 */
export function fitWeights(
  weights: readonly number[],
  span: number,
  min: number,
): readonly number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (weights.length === 0 || total <= 0) return weights;
  if (weights.every((weight) => (weight / total) * span >= min)) return weights;
  if (span <= weights.length * min) return weights.map(() => min);
  const locked = new Set<number>();
  let sizes: number[] = [];
  for (let round = 0; round <= weights.length; round += 1) {
    const free = weights.flatMap((weight, i) =>
      locked.has(i) ? [] : [weight],
    );
    const freeTotal = free.reduce((sum, weight) => sum + weight, 0);
    const room = span - locked.size * min;
    sizes = weights.map((weight, i) =>
      locked.has(i) ? min : (weight / freeTotal) * room,
    );
    const violators = sizes.flatMap((size, i) =>
      !locked.has(i) && size < min ? [i] : [],
    );
    if (violators.length === 0) break;
    for (const index of violators) locked.add(index);
  }
  const rounded = sizes.map((size) => Math.max(min, Math.round(size)));
  const spare = span - rounded.reduce((sum, size) => sum + size, 0);
  const widest = rounded.indexOf(Math.max(...rounded));
  rounded[widest] = (rounded[widest] ?? min) + spare;
  return rounded;
}

/** The layout clamped to the viewport. Pure; fitting a fitted layout changes nothing. */
export function fitLayout(
  layout: ShellLayout,
  viewport: Viewport,
): ShellLayout {
  const sidebarWidth = Math.round(
    clamp(layout.sidebar.width, sidebarBounds(layout, viewport)),
  );
  const panelHeight = Math.round(
    clamp(layout.panel.height, panelBounds(layout, viewport)),
  );
  const row = layout.editor.orientation === 'row';
  const span = row
    ? viewport.width -
      FIT.activityBar -
      (layout.sidebar.visible ? sidebarWidth : 0)
    : viewport.height -
      FIT.statusBar -
      (layout.panel.visible ? panelHeight : 0);
  const weights = fitWeights(
    layout.editor.groups.map((group) => group.weight),
    span,
    row ? FIT.groupMinWidth : FIT.groupMinHeight,
  );
  const last = layout.editor.groups.length - 1;
  return {
    ...layout,
    sidebar: { ...layout.sidebar, width: sidebarWidth },
    panel: { ...layout.panel, height: panelHeight },
    editor: {
      ...layout.editor,
      groups: layout.editor.groups.map((group, i) => ({
        ...group,
        weight: weights[i] ?? group.weight,
      })),
      activeGroup: Math.min(Math.max(layout.editor.activeGroup, 0), last),
    },
  };
}

/** The room along the editor's axis, after the sidebar (row) or the panel (column). */
function editorSpan(layout: ShellLayout, viewport: Viewport): number {
  return layout.editor.orientation === 'row'
    ? viewport.width -
        FIT.activityBar -
        (layout.sidebar.visible ? layout.sidebar.width : 0)
    : viewport.height -
        FIT.statusBar -
        (layout.panel.visible ? layout.panel.height : 0);
}

const groupMin = (layout: ShellLayout): number =>
  layout.editor.orientation === 'row' ? FIT.groupMinWidth : FIT.groupMinHeight;

/** The size of each editor group in pixels along the editor's axis, from the weights. */
export function groupPixels(
  layout: ShellLayout,
  viewport: Viewport,
): readonly number[] {
  const weights = layout.editor.groups.map((group) => group.weight);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const span = editorSpan(layout, viewport);
  return weights.map((weight) => (total > 0 ? (weight / total) * span : 0));
}

/** The sizes group `index` may have when it shares a splitter with the group after it. */
export function groupSplitBounds(
  layout: ShellLayout,
  viewport: Viewport,
  index: number,
): Bounds {
  const sizes = groupPixels(layout, viewport);
  const pair = (sizes[index] ?? 0) + (sizes[index + 1] ?? 0);
  const min = groupMin(layout);
  return { min, max: Math.max(min, Math.round(pair - min)) };
}

/**
 * Moves the splitter between group `index` and the next one so that group `index` is `pixels`
 * long (within the bounds). All weights become pixel sizes, so the proportions stay as they were.
 */
export function resizeGroups(
  layout: ShellLayout,
  viewport: Viewport,
  index: number,
  pixels: number,
): ShellLayout {
  const sizes = groupPixels(layout, viewport);
  if (index < 0 || index + 1 >= sizes.length) return layout;
  const pair = (sizes[index] ?? 0) + (sizes[index + 1] ?? 0);
  const first = Math.round(
    clamp(pixels, groupSplitBounds(layout, viewport, index)),
  );
  const next = sizes.map((size) => Math.max(1, Math.round(size)));
  next[index] = first;
  next[index + 1] = Math.max(1, Math.round(pair) - first);
  return {
    ...layout,
    editor: {
      ...layout.editor,
      groups: layout.editor.groups.map((group, i) => ({
        ...group,
        weight: next[i] ?? group.weight,
      })),
    },
  };
}
