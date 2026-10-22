// Value and time formatting for axes, readouts and tables (M1-54, R6). Numbers follow the person's locale; the unit
// symbols (B, KiB, /s) are symbols, not words. Never prints NaN or Infinity. Pure; no DOM.

export type Unit = 'messages' | 'count' | 'bytes' | 'per-second';

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

function number(
  value: number,
  locale: string | undefined,
  options: Intl.NumberFormatOptions,
): string {
  // `-0` reads `0`, and a value that rounds to zero keeps no sign.
  const fixed = Object.is(value, -0) ? 0 : value;
  return new Intl.NumberFormat(locale, options).format(fixed);
}

/** A value with its unit: counts compact (1.2K), bytes in powers of 1024, rates with `/s`. A non-finite value is an en dash. */
export function formatValue(
  value: number,
  unit: Unit,
  locale?: string,
): string {
  if (!Number.isFinite(value)) return '–';
  if (unit === 'bytes') {
    const size = Math.abs(value);
    const power = Math.min(
      BYTE_UNITS.length - 1,
      size < 1024 ? 0 : Math.floor(Math.log2(size) / 10),
    );
    const scaled = value / 1024 ** power;
    return `${number(scaled, locale, { maximumFractionDigits: power === 0 ? 0 : 1 })} ${BYTE_UNITS[power] ?? 'B'}`;
  }
  const small = Math.abs(value) < 10 && !Number.isInteger(value);
  const text = number(value, locale, {
    notation: 'compact',
    maximumFractionDigits: small || unit === 'per-second' ? 2 : 1,
  });
  return unit === 'per-second' ? `${text}/s` : text;
}

/** A time of day for an axis or a readout (`12:30:05`), in the person's locale and time zone. */
export function formatClock(epochMs: number, locale?: string): string {
  if (!Number.isFinite(epochMs)) return '–';
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(epochMs);
}
