// One death record from one table. The two forms differ only in the names of the fields and the
// unit of the time (x-death.ts and x-opt-deaths.ts describe them); this file reads either one.
// A field that is missing or unusable is null with a flag. Nothing is defaulted, derived from
// another field or guessed, except one fact that is exact: a record that died once has a last
// death equal to its first.
import { LIMITS } from './limits.ts';
import {
  field,
  isTable,
  readArray,
  readInteger,
  readText,
  readTimeMs,
  type ReadContext,
} from './read.ts';
import {
  DEATH_REASONS,
  type DeathEntry,
  type DeathReason,
  type DeathSource,
  type EntryFlag,
} from './types.ts';

/** How one form names and measures the fields of a death record. */
export interface DeathForm {
  /** The header (0-9-1) or message annotation (1.0) that holds the array. */
  readonly name: DeathSource;
  readonly timeUnit: 'seconds' | 'ms';
  /** `time` (the first death, 0-9-1) or `first-time` (1.0). */
  readonly firstTime: string;
  /** `last-time` (1.0 only); null when the form does not carry it. */
  readonly lastTime: string | null;
  /** `original-expiration` (a string of milliseconds) or `ttl` (an integer of milliseconds). */
  readonly ttl: string;
}

const KNOWN_REASONS: ReadonlySet<string> = new Set(DEATH_REASONS);

const TTL_TEXT = /^\d{1,15}$/;

function readTtl(
  ctx: ReadContext,
  table: unknown,
  name: string,
  flags: Set<EntryFlag>,
): number | null {
  const raw = field(ctx, table, name);
  if (raw === undefined) return null;
  const whole = readInteger(ctx, raw);
  if (whole !== null && whole >= 0) return whole;
  const text = readText(ctx, raw, 16);
  if (text !== null && !text.truncated && TTL_TEXT.test(text.text)) {
    return Number(text.text);
  }
  flags.add('ttl-invalid');
  return null;
}

function readRoutingKeys(
  ctx: ReadContext,
  table: unknown,
  flags: Set<EntryFlag>,
): string[] {
  const read = readArray(
    ctx,
    field(ctx, table, 'routing-keys'),
    LIMITS.maxRoutingKeys,
  );
  if (read === null) {
    flags.add('routing-keys-invalid');
    return [];
  }
  const keys: string[] = [];
  for (const item of read.items) {
    const text = readText(ctx, item);
    if (text === null) {
      flags.add('routing-keys-invalid');
    } else {
      keys.push(text.text);
      if (text.truncated) flags.add('text-truncated');
    }
  }
  if (read.total > read.items.length) {
    ctx.routingKeysDropped += read.total - read.items.length;
    flags.add('routing-keys-truncated');
  }
  return keys;
}

/** The record at position `index` of the array, read as `form`. */
export function readEntry(
  ctx: ReadContext,
  raw: unknown,
  index: number,
  form: DeathForm,
): DeathEntry {
  const flags = new Set<EntryFlag>();
  if (!isTable(raw)) {
    return {
      index,
      queue: null,
      reason: null,
      reasonText: null,
      count: null,
      exchange: null,
      routingKeys: [],
      firstTimeMs: null,
      lastTimeMs: null,
      originalTtlMs: null,
      flags: ['not-a-table'],
    };
  }

  const text = (name: string): string | null => {
    const read = readText(ctx, field(ctx, raw, name));
    if (read?.truncated === true) flags.add('text-truncated');
    return read?.text ?? null;
  };

  const queue = text('queue');
  if (queue === null) flags.add('queue-missing');

  const reasonRaw = text('reason');
  let reason: DeathReason | null = null;
  let reasonText: string | null = null;
  if (reasonRaw === null) {
    flags.add('reason-missing');
  } else if (KNOWN_REASONS.has(reasonRaw)) {
    reason = reasonRaw as DeathReason;
  } else {
    reasonText = reasonRaw;
    flags.add('reason-unknown');
  }

  const countRaw = readInteger(ctx, field(ctx, raw, 'count'));
  const count = countRaw !== null && countRaw >= 1 ? countRaw : null;
  if (count === null) flags.add('count-invalid');

  const exchange = text('exchange');
  if (exchange === null) flags.add('exchange-missing');

  const routingKeys = readRoutingKeys(ctx, raw, flags);

  const firstTimeMs = readTimeMs(
    ctx,
    field(ctx, raw, form.firstTime),
    form.timeUnit,
  );
  if (firstTimeMs === null) flags.add('time-invalid');

  let lastTimeMs: number | null = null;
  if (form.lastTime !== null) {
    lastTimeMs = readTimeMs(ctx, field(ctx, raw, form.lastTime), form.timeUnit);
    if (lastTimeMs === null) flags.add('last-time-invalid');
  } else if (count === 1 && firstTimeMs !== null) {
    // Died once: the last death is the first. Any other count leaves it unknown.
    lastTimeMs = firstTimeMs;
  } else {
    flags.add('last-time-unavailable');
  }

  return {
    index,
    queue,
    reason,
    reasonText,
    count,
    exchange,
    routingKeys,
    firstTimeMs,
    lastTimeMs,
    originalTtlMs: readTtl(ctx, raw, form.ttl, flags),
    flags: [...flags],
  };
}
