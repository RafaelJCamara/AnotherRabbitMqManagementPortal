import { describe, expect, it } from 'vitest';

import { mountShell, visit } from '../test-fixtures';
import {
  FIT,
  fitLayout,
  fitWeights,
  panelBounds,
  sidebarBounds,
  type Viewport,
} from './fit-layout';
import { defaultLayout, type ShellLayout } from './shell-layout';

function stored(
  weights: readonly number[],
  orientation: 'row' | 'column' = 'row',
): ShellLayout {
  const layout = defaultLayout();
  return {
    ...layout,
    sidebar: { ...layout.sidebar, visible: true, width: 900 },
    panel: { ...layout.panel, visible: true, height: 700 },
    editor: {
      orientation,
      groups: weights.map((weight) => ({ weight, tabs: [], activeTab: null })),
      activeGroup: 0,
    },
  };
}

const WIDE: Viewport = { width: 1280, height: 720 };
const NARROW: Viewport = { width: 1024, height: 600 };
const VIEWPORTS: readonly Viewport[] = [WIDE, NARROW];

function occupied(layout: ShellLayout, viewport: Viewport) {
  const { groups, orientation } = layout.editor;
  const sizes = groups.map((group) => group.weight);
  const total = sizes.reduce((sum, weight) => sum + weight, 0);
  const width =
    viewport.width -
    FIT.activityBar -
    (layout.sidebar.visible ? layout.sidebar.width : 0);
  const height =
    viewport.height -
    FIT.statusBar -
    (layout.panel.visible ? layout.panel.height : 0);
  const span = orientation === 'row' ? width : height;
  return { width, height, shares: sizes.map((size) => (size / total) * span) };
}

describe('fitLayout', () => {
  it('AC-9 every region fits 1280x720 and an oversized stored layout is clamped, not scrolled', async () => {
    for (const viewport of VIEWPORTS) {
      for (const orientation of ['row', 'column'] as const) {
        const huge = stored([5, 3, 1, 1], orientation);
        const fitted = fitLayout(huge, viewport);
        const room = occupied(fitted, viewport);

        // Activity bar, sidebar and editor add up to the width; panel, editor and status bar to
        // the height; the editor keeps its minimum in both directions.
        expect(fitted.sidebar.width).toBeLessThanOrEqual(
          viewport.width - FIT.activityBar - FIT.editorMinWidth,
        );
        expect(fitted.sidebar.width).toBeGreaterThanOrEqual(FIT.sidebarMin);
        expect(room.width).toBeGreaterThanOrEqual(FIT.editorMinWidth);
        expect(fitted.panel.height).toBeLessThanOrEqual(
          viewport.height - FIT.statusBar - FIT.editorMinHeight,
        );
        expect(fitted.panel.height).toBeGreaterThanOrEqual(FIT.panelMin);
        expect(room.height).toBeGreaterThanOrEqual(FIT.editorMinHeight);

        // Each group has at least its minimum along the editor's axis.
        const min =
          orientation === 'row' ? FIT.groupMinWidth : FIT.groupMinHeight;
        for (const share of room.shares)
          expect(share).toBeGreaterThanOrEqual(min);

        // Idempotent.
        expect(fitLayout(fitted, viewport)).toEqual(fitted);
        // Bounds the splitters use agree with the fit.
        expect(sidebarBounds(huge, viewport).max).toBe(fitted.sidebar.width);
        expect(panelBounds(huge, viewport).max).toBe(fitted.panel.height);
      }
    }

    // A layout that already fits is not touched, and weights keep their proportions.
    const fits = fitLayout(stored([2, 1]), WIDE);
    expect(fits.editor.groups.map((g) => g.weight)).toEqual([2, 1]);
    const tight = fitLayout(stored([4, 2, 2]), WIDE);
    expect(tight.editor.groups.map((g) => g.weight)).toEqual([288, 160, 160]);
    expect(fitWeights([1, 1, 1], 600, 160)).toEqual([1, 1, 1]);

    // A window smaller than the minimums is clamped to them, never to a negative size.
    const tiny = fitLayout(stored([1, 1, 1]), { width: 300, height: 200 });
    expect(tiny.sidebar.width).toBe(FIT.sidebarMin);
    expect(tiny.panel.height).toBe(FIT.panelMin);
    expect(tiny.editor.groups.every((g) => g.weight > 0)).toBe(true);

    // The cells of the shell grid shrink and clip: no horizontal overflow from a wide child.
    // (the stylesheet text Angular put in the document for the mounted shell)
    const bed = await mountShell();
    await visit(bed, '/c/c1/explorer');
    const css = [...document.querySelectorAll('style')]
      .map((style) => style.textContent)
      .join('\n');
    const rule = (name: string): string =>
      new RegExp(`\\.${name}(\\[[^\\]]*\\])*\\s*\\{[^}]*\\}`).exec(css)?.[0] ??
      '';
    expect(rule('shell')).toMatch(/min-width:\s*0/);
    expect(rule('shell')).toMatch(/overflow:\s*hidden/);
    for (const cell of ['main', 'workspace', 'sidebar']) {
      expect(rule(cell), cell).toMatch(/min-width:\s*0/);
    }
    expect(css).toMatch(/minmax\(0,\s*1fr\)/);
  });

  it('clamps the active group to the groups that exist', () => {
    const layout = stored([1, 1]);
    const fitted = fitLayout(
      { ...layout, editor: { ...layout.editor, activeGroup: 7 } },
      WIDE,
    );
    expect(fitted.editor.activeGroup).toBe(1);
  });
});
