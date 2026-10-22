// The forecast overlay in data coordinates (M1-54, R5, R6): a segment from the newest point along the drain to the
// zero line, and the 95 % band on the zero line. The numbers are the engine's; nothing is computed here but the
// clipping to the plot. A forecast that is not usable gives no overlay (fail closed). Pure; no DOM.
import type { Point } from './downsample';

/** What the host passes for an `ok` forecast: the ETA and its band as the engine sent them, in milliseconds from now. */
export interface OverlayForecast {
  readonly etaMs: number;
  readonly lowMs: number;
  /** `null`: the slope could be flat within the band, so there is no upper bound. */
  readonly highMs: number | null;
}

export interface Overlay {
  /** The drain line, from the newest point to the end of the visible part. */
  readonly line: { readonly from: Point; readonly to: Point };
  /** Where the ETA falls; `null` when it is beyond the right edge of the chart. */
  readonly etaT: number | null;
  /** The band on the zero line, clipped to the chart; `open` when it goes on past the right edge. */
  readonly band: {
    readonly fromT: number;
    readonly toT: number;
    readonly open: boolean;
  } | null;
  /** The ETA is further than the chart reaches: the host says it in words. */
  readonly beyond: boolean;
}

/** The room the chart keeps to the right of "now" for the overlay: a quarter of the visible span. */
export const OVERLAY_ROOM = 0.25;

/** The domain with room on the right for an overlay. */
export function withOverlayRoom(domain: { from: number; to: number }): {
  from: number;
  to: number;
} {
  return {
    from: domain.from,
    to: domain.to + (domain.to - domain.from) * OVERLAY_ROOM,
  };
}

const usable = (forecast: OverlayForecast): boolean =>
  Number.isFinite(forecast.etaMs) &&
  forecast.etaMs > 0 &&
  Number.isFinite(forecast.lowMs) &&
  forecast.lowMs >= 0 &&
  forecast.lowMs <= forecast.etaMs &&
  (forecast.highMs === null ||
    (Number.isFinite(forecast.highMs) && forecast.highMs >= forecast.etaMs));

/**
 * The overlay for `forecast` drawn from the `latest` point inside `domain` (the visible time range, with room
 * for the overlay). `null` when the forecast is not usable, the backlog is already zero, or the newest point
 * is not inside the domain.
 */
export function forecastOverlay(
  forecast: OverlayForecast,
  latest: Point,
  domain: { from: number; to: number },
): Overlay | null {
  if (
    !usable(forecast) ||
    !Number.isFinite(latest.t) ||
    !Number.isFinite(latest.v) ||
    latest.v <= 0 ||
    latest.t < domain.from ||
    latest.t >= domain.to
  ) {
    return null;
  }
  const etaT = latest.t + forecast.etaMs;
  const beyond = etaT > domain.to;
  const endT = beyond ? domain.to : etaT;
  const valueAt = (t: number): number =>
    Math.max(0, latest.v * (1 - (t - latest.t) / forecast.etaMs));
  const bandFrom = latest.t + forecast.lowMs;
  const bandTo =
    forecast.highMs === null ? Infinity : latest.t + forecast.highMs;
  const clippedFrom = Math.max(bandFrom, latest.t);
  const clippedTo = Math.min(bandTo, domain.to);
  return {
    line: {
      from: latest,
      to: { t: endT, v: beyond ? valueAt(endT) : 0 },
    },
    etaT: beyond ? null : etaT,
    band:
      clippedFrom <= clippedTo && bandFrom <= domain.to
        ? { fromT: clippedFrom, toT: clippedTo, open: bandTo > domain.to }
        : null,
    beyond,
  };
}
