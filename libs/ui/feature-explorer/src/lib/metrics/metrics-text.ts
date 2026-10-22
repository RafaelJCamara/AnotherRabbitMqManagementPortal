// The words of the metrics views (M1-54), as pure functions over the model's results and the `t` of the template.
// The engine's fixed codes become sentences by key; a code this version has no sentence for is still shown, with the
// engine's word, never dropped. The wording rules of the explorer apply (DC-15).
import type { ChartLabels } from '@app/ui-charts';
import {
  KNOWN_PARTIAL_REASONS,
  type Explanation,
  type ForecastView,
  type LineData,
  type MetricsStatus,
} from '@app/metrics-model';

import type { Translate } from '../translate';
import { formatDuration, formatTime } from './metrics-format';

/** One sentence per explanation of the engine's status. */
export function explainText(item: Explanation, t: Translate): string {
  switch (item.code) {
    case 'stale':
      return item.asOf === undefined
        ? t('explorer.metrics.explain.staleUnknown')
        : t('explorer.metrics.explain.stale', { time: formatTime(item.asOf) });
    case 'partial': {
      const reason = item.reason ?? '';
      return KNOWN_PARTIAL_REASONS.includes(reason)
        ? t(`explorer.metrics.partial.${reason}`)
        : t('explorer.metrics.partial.unknown', { reason });
    }
    case 'dropped-points':
    case 'dropped-series':
    case 'dropped-samples':
      return t(`explorer.metrics.explain.${item.code}`, {
        count: item.count ?? 0,
      });
    default:
      return t(`explorer.metrics.explain.${item.code}`);
  }
}

/** Why a line of a chart is not drawn, in a few words, from the status the engine sent. */
export function reasonKey(
  line: LineData,
  status: MetricsStatus | null,
): string {
  if (line.state === 'pending' || status === null) {
    return 'explorer.metrics.reason.pending';
  }
  if (status.state === 'loading') return 'explorer.metrics.reason.loading';
  if (status.source === 'none') return 'explorer.metrics.reason.no-source';
  return 'explorer.metrics.reason.absent';
}

/** The texts of a chart, translated once per language. */
export function chartLabels(t: Translate, title: string): ChartLabels {
  const k = (name: string): string => t(`explorer.metrics.chartLabels.${name}`);
  return {
    keyboardHint: k('keyboardHint'),
    legend: k('legend'),
    noData: k('noData'),
    notReported: k('notReported'),
    noPoint: k('noPoint'),
    approximate: k('approximate'),
    tableSummary: k('tableSummary'),
    tableCaption: t('explorer.metrics.chartLabels.tableCaption', {
      chart: title,
    }),
    timeColumn: k('timeColumn'),
    olderRows: (count) =>
      t('explorer.metrics.chartLabels.olderRows', { count }),
    forecastBeyond: k('forecastBeyond'),
    forecastDrawn: k('forecastDrawn'),
  };
}

/** The sentence a forecast says, for every state; never an ETA unless the engine sent one. */
export function forecastSentence(
  view: ForecastView,
  t: Translate,
  locale?: string,
): string {
  const key = (name: string): string =>
    `explorer.metrics.forecast.state.${name}`;
  switch (view.state) {
    case 'ok':
      return view.highMs === null
        ? t(key('okOpen'), {
            eta: formatDuration(view.etaMs, locale),
            low: formatDuration(view.lowMs, locale),
          })
        : t(key('ok'), {
            eta: formatDuration(view.etaMs, locale),
            low: formatDuration(view.lowMs, locale),
            high: formatDuration(view.highMs, locale),
          });
    case 'reached':
      return t(key('reached'));
    case 'moving-away':
      return t(key(`moving-away.${view.reason}`));
    case 'no-reliable-forecast':
      return t(key('no-reliable-forecast'), { r2: view.r2Percent });
    case 'insufficient-data':
      return t(key('insufficient-data'), {
        points: view.points,
        span: formatDuration(view.spanMs, locale),
        needed: view.needed.points,
        neededSpan: formatDuration(view.needed.spanMs, locale),
      });
    case 'unavailable':
      return t(key('unavailable'));
  }
}
