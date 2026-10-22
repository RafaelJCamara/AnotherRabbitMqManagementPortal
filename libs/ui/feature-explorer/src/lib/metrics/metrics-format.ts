// Small text helpers of the metrics views (M1-54): durations in the person's locale (Intl units, no copy of our own),
// and the percentage and time of a forecast.
export function formatDuration(ms: number, locale?: string): string {
  if (!Number.isFinite(ms) || ms < 0) return '–';
  const unit = (value: number, name: string): string =>
    new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: name,
      unitDisplay: 'short',
      maximumFractionDigits: 0,
    }).format(value);
  const seconds = Math.round(ms / 1000);
  const parts: [number, string, number][] = [
    [86_400, 'day', 3600],
    [3600, 'hour', 60],
    [60, 'minute', 1],
  ];
  for (const [size, name, next] of parts) {
    if (seconds >= size) {
      const big = Math.floor(seconds / size);
      const rest = Math.floor((seconds % size) / next);
      const nextName =
        name === 'day' ? 'hour' : name === 'hour' ? 'minute' : 'second';
      return rest > 0
        ? `${unit(big, name)} ${unit(rest, nextName)}`
        : unit(big, name);
    }
  }
  return unit(seconds, 'second');
}

/** A time of day (hours, minutes, seconds) in the person's locale. */
export function formatTime(epochMs: number, locale?: string): string {
  if (!Number.isFinite(epochMs)) return '–';
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(epochMs);
}
