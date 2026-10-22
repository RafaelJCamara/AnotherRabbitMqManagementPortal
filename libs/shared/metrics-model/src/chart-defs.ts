// Which charts a page shows and which series each draws (M1-54, OQ-924), and the time ranges the person can pick
// (R9). Data only, no copy: the page words each chart and series by its id. The series are the engine's catalogue
// (`METRIC_IDS`); a counter is drawn as a per-second rate derived on the client from the raw values (OQ-922).
import type { MetricId } from '@app/contracts';
import { counterRate, type Point } from '@app/forecast';

import type { QueueRef, SeriesRef } from './ports';
import { refKey } from './series-key';
import type { SeriesView, SessionState } from './session';

export type ChartUnit = 'messages' | 'count' | 'bytes' | 'per-second';
export type ChartId =
  | 'backlog'
  | 'rates'
  | 'consumers'
  | 'memory'
  | 'disk'
  | 'queue-depth'
  | 'queue-consumers';

export interface LineDef {
  /** The series key; the id of the line in a chart. */
  readonly id: string;
  readonly ref: SeriesRef;
  readonly metric: MetricId;
  readonly node: string | undefined;
  /** A counter drawn as a per-second rate. */
  readonly rate: boolean;
  /** Colour, dash and marker (0 to 5, wrapping). */
  readonly style: number;
}

export interface ChartDef {
  readonly id: ChartId;
  readonly unit: ChartUnit;
  readonly lines: readonly LineDef[];
  /** The line the forecast overlay hangs on (the depth), or `null` when the chart has no forecast. */
  readonly forecastAnchor: string | null;
}

const line = (ref: SeriesRef, style: number, rate = false): LineDef => ({
  id: refKey(ref),
  ref,
  metric: ref.metric,
  node: ref.node,
  rate,
  style,
});

const cluster = (metric: MetricId, style: number, rate = false): LineDef =>
  line({ metric }, style, rate);

/** Nodes beyond this many are not charted, and the page says how many were left out (the query limit is 50 series). */
export const MAX_CHART_NODES = 8;

export function clusterCharts(nodes: readonly string[]): {
  readonly charts: readonly ChartDef[];
  readonly omittedNodes: number;
} {
  const shown = [...nodes].sort().slice(0, MAX_CHART_NODES);
  const perNode = (used: MetricId, limit: MetricId): LineDef[] => [
    ...shown.map((node, i) => line({ metric: used, node }, i)),
    ...shown.map((node, i) => line({ metric: limit, node }, i + shown.length)),
  ];
  const messages = cluster('messages', 2);
  return {
    omittedNodes: Math.max(0, nodes.length - shown.length),
    charts: [
      {
        id: 'backlog',
        unit: 'messages',
        lines: [
          cluster('messages_ready', 0),
          cluster('messages_unacked', 1),
          messages,
        ],
        forecastAnchor: messages.id,
      },
      {
        id: 'rates',
        unit: 'per-second',
        lines: [
          cluster('published_total', 0, true),
          cluster('delivered_total', 1, true),
          cluster('acked_total', 2, true),
          cluster('redelivered_total', 3, true),
        ],
        forecastAnchor: null,
      },
      {
        id: 'consumers',
        unit: 'count',
        lines: [
          cluster('consumers', 0),
          cluster('channels', 1),
          cluster('connections', 2),
        ],
        forecastAnchor: null,
      },
      {
        id: 'memory',
        unit: 'bytes',
        lines: perNode('memory_bytes', 'memory_limit_bytes'),
        forecastAnchor: null,
      },
      {
        id: 'disk',
        unit: 'bytes',
        lines: perNode('disk_free_bytes', 'disk_free_limit_bytes'),
        forecastAnchor: null,
      },
    ],
  };
}

export function queueCharts(queue: QueueRef): readonly ChartDef[] {
  const of = (metric: MetricId, style: number): LineDef =>
    line({ metric, queue }, style);
  const total = of('queue_messages', 2);
  return [
    {
      id: 'queue-depth',
      unit: 'messages',
      lines: [
        of('queue_messages_ready', 0),
        of('queue_messages_unacked', 1),
        total,
      ],
      forecastAnchor: total.id,
    },
    {
      id: 'queue-consumers',
      unit: 'count',
      lines: [of('queue_consumers', 0)],
      forecastAnchor: null,
    },
  ];
}

/** Every distinct series the charts draw, in order, for the session. */
export function seriesOf(charts: readonly ChartDef[]): SeriesRef[] {
  const seen = new Set<string>();
  const out: SeriesRef[] = [];
  for (const chart of charts) {
    for (const def of chart.lines) {
      if (!seen.has(def.id)) {
        seen.add(def.id);
        out.push(def.ref);
      }
    }
  }
  return out;
}

export interface LineData {
  readonly def: LineDef;
  readonly view: SeriesView | undefined;
  /** `pending` until the history was answered. */
  readonly state: 'pending' | 'drawn' | 'not-reported';
  /** The values to draw: raw, or the rate of a counter. */
  readonly points: readonly Point[];
  readonly approximate: boolean;
}

/** What one chart draws now, from the session's state. */
export function chartData(chart: ChartDef, state: SessionState): LineData[] {
  const byKey = new Map(state.series.map((view) => [view.key, view]));
  return chart.lines.map((def): LineData => {
    const view = byKey.get(def.id);
    const raw = view?.points ?? [];
    return {
      def,
      view,
      state: view?.state ?? 'pending',
      points: def.rate ? counterRate(raw) : raw,
      approximate: view?.approximate ?? false,
    };
  });
}

// ---- Ranges -----------------------------------------------------------------------------------------------

export interface RangeDef {
  readonly id: '5m' | '15m' | '30m' | '1h';
  readonly ms: number;
}

const MINUTE = 60_000;
/** The ranges the hot window can serve: it holds one hour. The range filters the ring and asks nothing. */
export const RANGES: readonly RangeDef[] = [
  { id: '5m', ms: 5 * MINUTE },
  { id: '15m', ms: 15 * MINUTE },
  { id: '30m', ms: 30 * MINUTE },
  { id: '1h', ms: 60 * MINUTE },
];
export const DEFAULT_RANGE: RangeDef['id'] = '15m';
/** Listed disabled: they need the persisted store (M4-04). */
export const LATER_RANGES: readonly string[] = ['6h', '24h', '7d'];

export function rangeOf(id: string): RangeDef {
  return (
    RANGES.find((range) => range.id === id) ??
    RANGES[1] ?? { id: '15m', ms: 15 * MINUTE }
  );
}

/** The visible time range: it ends at the newest point (a chart whose feed stopped stops with it). */
export function domainOf(
  newestT: number | null,
  rangeMs: number,
): { readonly from: number; readonly to: number } {
  const to = newestT ?? rangeMs;
  return { from: to - rangeMs, to };
}
