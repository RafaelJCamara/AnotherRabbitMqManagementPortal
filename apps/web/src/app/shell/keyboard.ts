// Small keyboard helpers shared by the splitter, the tab lists and the tree (WAI-ARIA authoring
// practices: roving tabindex, arrow keys, Home and End).

export type Axis = 'horizontal' | 'vertical';

/** -1, 0 or 1 for an arrow key along `axis`; 0 for every other key. */
export function stepFor(key: string, axis: Axis): -1 | 0 | 1 {
  if (axis === 'horizontal') {
    if (key === 'ArrowRight') return 1;
    if (key === 'ArrowLeft') return -1;
  } else {
    if (key === 'ArrowDown') return 1;
    if (key === 'ArrowUp') return -1;
  }
  return 0;
}

/**
 * The index to focus after `key` in a list of `count` items along `axis`, wrapping at the ends;
 * null when the key does not move focus.
 */
export function rovingIndex(
  key: string,
  current: number,
  count: number,
  axis: Axis,
): number | null {
  if (count <= 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  const step = stepFor(key, axis);
  if (step === 0) return null;
  return (current + step + count) % count;
}
