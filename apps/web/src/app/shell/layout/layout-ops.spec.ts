import { describe, expect, it } from 'vitest';

import { FIT, groupPixels, groupSplitBounds, resizeGroups } from './fit-layout';
import { twoGroupLayout, VIEWPORT_1280 } from './layout-fixtures';
import {
  activateTab,
  closeEmptyGroup,
  closeTab,
  neighbourOf,
  setOrientation,
  showActivity,
  splitEditor,
  type LayoutResult,
} from './layout-ops';
import {
  defaultLayout,
  ShellLayoutSchema,
  type ShellLayout,
} from './shell-layout';

const layout = (): ShellLayout => twoGroupLayout('c1');
const tabIds = (l: ShellLayout, group: number) =>
  l.editor.groups[group]?.tabs.map((t) => t.id);
const must = (result: LayoutResult): ShellLayout => {
  if (!result.ok) throw new Error(result.refusal);
  return result.layout;
};

describe('layout operations', () => {
  it('closing the active tab makes the next one active, the last one makes the previous one active', () => {
    const base = layout();
    // t2 is active, t3 follows it.
    const afterT2 = closeTab(base, 0, 't2');
    expect(tabIds(afterT2, 0)).toEqual(['t1', 't3']);
    expect(afterT2.editor.groups[0]?.activeTab).toBe('t3');
    const last = activateTab(base, 0, 't3');
    expect(closeTab(last, 0, 't3').editor.groups[0]?.activeTab).toBe('t2');
    // A tab that is not active leaves the active tab alone; the empty group stays.
    expect(closeTab(base, 0, 't1').editor.groups[0]?.activeTab).toBe('t2');
    const empty = closeTab(base, 1, 't4');
    expect(empty.editor.groups[1]).toMatchObject({ tabs: [], activeTab: null });
    expect(empty.editor.groups).toHaveLength(2);
    // Nothing to close: the same layout comes back.
    expect(closeTab(base, 0, 'nope')).toBe(base);
    expect(closeTab(base, 9, 't1')).toBe(base);
    for (const result of [afterT2, last, empty]) {
      expect(ShellLayoutSchema.safeParse(result).success).toBe(true);
    }
  });

  it('tells which tab takes the place of a closed one', () => {
    const base = layout();
    expect(neighbourOf(base, 0, 't2')).toBe('t3');
    expect(neighbourOf(base, 0, 't3')).toBe('t2');
    expect(neighbourOf(base, 1, 't4')).toBeNull();
    expect(neighbourOf(base, 5, 't4')).toBeNull();
  });

  it('activating a tab activates its group; unknown tabs change nothing', () => {
    const base = layout();
    const next = activateTab(base, 1, 't4');
    expect(next.editor.activeGroup).toBe(1);
    expect(activateTab(next, 1, 't4')).toBe(next);
    expect(activateTab(base, 0, 't4')).toBe(base);
    expect(activateTab(base, 7, 't1')).toBe(base);
  });

  it('closes an empty group only, never the last one, and keeps the active group in range', () => {
    const base = layout();
    expect(closeEmptyGroup(base, 1)).toBe(base); // it has a tab
    const emptied = closeTab(base, 1, 't4');
    const closed = closeEmptyGroup(
      { ...emptied, editor: { ...emptied.editor, activeGroup: 1 } },
      1,
    );
    expect(closed.editor.groups).toHaveLength(1);
    expect(closed.editor.activeGroup).toBe(0);
    const single = defaultLayout();
    expect(closeEmptyGroup(single, 0)).toBe(single);
    // Closing a group before the active one moves the index with it.
    const three = must(splitEditor(must(splitEditor(defaultLayout()))));
    const second = { ...three, editor: { ...three.editor, activeGroup: 2 } };
    expect(closeEmptyGroup(second, 0).editor.activeGroup).toBe(1);
  });

  it('changes the orientation and the sidebar entry', () => {
    const base = defaultLayout();
    expect(setOrientation(base, 'row')).toBe(base);
    expect(setOrientation(base, 'column').editor.orientation).toBe('column');
    const hidden = { ...base, sidebar: { ...base.sidebar, visible: false } };
    expect(showActivity(hidden, 'explorer').sidebar.visible).toBe(true);
  });
});

describe('editor group sizes', () => {
  it('turns the weights into pixels and moves a splitter within the bounds, keeping the sum', () => {
    const base = layout();
    const sizes = groupPixels(base, VIEWPORT_1280);
    const span = 1280 - FIT.activityBar - base.sidebar.width;
    expect(sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(span, 5);
    const bounds = groupSplitBounds(base, VIEWPORT_1280, 0);
    expect(bounds.min).toBe(FIT.groupMinWidth);
    expect(bounds.max).toBe(Math.round(span - FIT.groupMinWidth));

    const moved = resizeGroups(base, VIEWPORT_1280, 0, 700);
    const after = groupPixels(moved, VIEWPORT_1280);
    expect(after[0]).toBeCloseTo(700, 0);
    expect(after.reduce((a, b) => a + b, 0)).toBeCloseTo(span, 0);
    // Beyond the bounds the splitter stops at them.
    expect(
      groupPixels(
        resizeGroups(base, VIEWPORT_1280, 0, 99_999),
        VIEWPORT_1280,
      )[1],
    ).toBeCloseTo(FIT.groupMinWidth, 0);
    expect(
      groupPixels(resizeGroups(base, VIEWPORT_1280, 0, 1), VIEWPORT_1280)[0],
    ).toBeCloseTo(FIT.groupMinWidth, 0);
    // There is no splitter after the last group.
    expect(resizeGroups(base, VIEWPORT_1280, 1, 300)).toBe(base);
    expect(ShellLayoutSchema.safeParse(moved).success).toBe(true);
  });

  it('measures a column split along the height', () => {
    const base = setOrientation(layout(), 'column');
    const sizes = groupPixels(base, VIEWPORT_1280);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(
      720 - FIT.statusBar,
      5,
    );
    expect(groupSplitBounds(base, VIEWPORT_1280, 0).min).toBe(
      FIT.groupMinHeight,
    );
  });
});
