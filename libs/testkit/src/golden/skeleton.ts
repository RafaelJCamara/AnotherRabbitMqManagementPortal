// The shape of a recorded answer, for the refresh-diff (`record-golden --check`). A fresh recording
// never equals the committed one byte for byte (uptimes, counters, ports, timestamps), so the check
// compares what a client can depend on: which fields exist and what type each has.
//
// A JSON answer becomes a sorted list of `path: type` lines, for example
// `$.items[].name: string` or `$.items[].policy: null|string` (a path that carries several types
// lists them all). A Prometheus page becomes `# TYPE name kind` lines and the label names of each
// sample. Two answers have the same shape when the lists are equal; the difference is what the
// refresh workflow shows.

const TYPE_ORDER = ['null', 'boolean', 'number', 'string', 'object', 'array'];

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value === 'object' ? 'object' : typeof value;
}

/**
 * Subtrees whose keys depend on timing or on what the broker happened to measure, not on the
 * version: statistics rates and logs, garbage collection, per-queue backing-queue internals. They
 * are listed as one `{...}` line so their content does not make the diff flap.
 */
const VOLATILE_KEYS: readonly RegExp[] = [
  /_details$/,
  /^message_stats$/,
  /^queue_totals$/,
  /^garbage_collection$/,
  /^backing_queue_status$/,
  /^reductions$/,
  /^memory$/,
  /^node_stats$/,
];

function collect(value: unknown, path: string, into: Map<string, Set<string>>) {
  const add = (type: string): void => {
    const types = into.get(path) ?? new Set<string>();
    types.add(type);
    into.set(path, types);
  };
  const type = typeOf(value);
  if (type === 'array') {
    add('array');
    for (const item of value as unknown[]) collect(item, `${path}[]`, into);
    return;
  }
  if (type === 'object') {
    add('object');
    for (const [key, inner] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const child = `${path}.${key}`;
      if (VOLATILE_KEYS.some((pattern) => pattern.test(key))) {
        add('object');
        const types = into.get(child) ?? new Set<string>();
        types.add(typeOf(inner) === 'object' ? 'volatile' : typeOf(inner));
        into.set(child, types);
      } else {
        collect(inner, child, into);
      }
    }
    return;
  }
  add(type);
}

/** The shape lines of a parsed JSON answer. */
export function jsonShape(value: unknown): string[] {
  const into = new Map<string, Set<string>>();
  collect(value, '$', into);
  return [...into.entries()]
    .map(
      ([path, types]) =>
        `${path}: ${[...types]
          .sort(
            (a, b) =>
              TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b) ||
              a.localeCompare(b),
          )
          .join('|')}`,
    )
    .sort();
}

const SAMPLE = /^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{(.*)\})?\s+\S+(?:\s+\d+)?$/;
const LABEL_NAME = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"/g;

/** The shape lines of a Prometheus text page: families with their type, samples with label names. */
export function prometheusShape(text: string): string[] {
  const lines = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('# TYPE ')) {
      lines.add(line);
      continue;
    }
    if (line.startsWith('#')) continue;
    const match = SAMPLE.exec(line);
    if (!match?.[1]) {
      lines.add(`? ${line}`);
      continue;
    }
    // Label values (nodes, queue names) are data; only the label names are the shape.
    const labels = [...(match[2] ?? '').matchAll(LABEL_NAME)]
      .map((label) => label[1])
      .join(',');
    lines.add(`${match[1]}{${labels}}`);
  }
  return [...lines].sort();
}

/** What differs between two shape lists: lines only in `before`, and only in `after`. */
export function diffShapes(
  before: readonly string[],
  after: readonly string[],
): { readonly removed: string[]; readonly added: string[] } {
  const was = new Set(before);
  const is = new Set(after);
  return {
    removed: before.filter((line) => !is.has(line)),
    added: after.filter((line) => !was.has(line)),
  };
}
