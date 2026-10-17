// Small graph helpers shared by the item and feature checks.

/** `M3` becomes 3. Returns NaN for anything else so comparisons are false. */
export function milestoneRank(key: string): number {
  const match = /^M(\d+)$/.exec(key);
  return match ? Number(match[1]) : Number.NaN;
}

const NUMERIC_WAVE = /^M(\d+)-W(\d+)$/;

/** `M1-W3` becomes [1, 3]; named waves such as `M2-platform` or `M5` have no rank. */
export function waveRank(wave: string | null): [number, number] | null {
  if (wave === null) return null;
  const match = NUMERIC_WAVE.exec(wave);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

export function isNumericWave(wave: string | null): boolean {
  return waveRank(wave) !== null;
}

/**
 * Finds dependency cycles. Each cycle is returned once, rotated to start at its smallest id and
 * closed on itself, for example `A>B>C>A`. Edges to unknown nodes are ignored (they are reported
 * as dangling elsewhere).
 */
export function findCycles(
  edges: ReadonlyMap<string, readonly string[]>,
): string[] {
  const state = new Map<string, 1 | 2>();
  const found = new Set<string>();
  const stack: string[] = [];

  const visit = (node: string): void => {
    state.set(node, 1);
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      if (!edges.has(next)) continue;
      const seen = state.get(next);
      if (seen === 1) {
        const loop = stack.slice(stack.indexOf(next));
        const start = loop.indexOf([...loop].sort()[0] ?? next);
        const rotated = [...loop.slice(start), ...loop.slice(0, start)];
        found.add([...rotated, rotated[0] ?? next].join('>'));
      } else if (seen === undefined) visit(next);
    }
    stack.pop();
    state.set(node, 2);
  };

  for (const node of edges.keys()) {
    if (!state.has(node)) visit(node);
  }
  return [...found].sort();
}
