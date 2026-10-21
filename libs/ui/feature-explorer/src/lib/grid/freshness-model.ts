// What the grid page says about the freshness of what it shows (M0-54, R4). The sentences are built
// from the last answer's `freshness` and never from the rows, as keys with their values; the banner
// translates them. Nothing here is hidden: loading, stale, truncated, dropped, incomplete, a version
// that changed under a scroll and every hazard are each a line, and the engine's own reason is shown
// as it was sent.
import type {
  ExplorerKind,
  Freshness,
  WindowSourceState,
} from '@app/explorer-model';

import { problemView, type ProblemView } from '../problem';
import { isKnownHazard } from './hazards';

export interface FreshnessLine {
  /** Stable, for tracking the list. */
  readonly id: string;
  readonly tone: 'info' | 'warn';
  readonly key: string;
  readonly params?: Record<string, string | number>;
  /** The engine's fixed text, shown as sent. */
  readonly engine?: string;
}

/** The engine's reason for a bindings count that is only a minimum (`REASONS.unpagedCut`). */
const COUNT_NOT_KNOWN = 'is not known';

export function freshnessLines(
  freshness: Freshness,
  kind: ExplorerKind,
  options: {
    /** Times the list changed under a scroll and was reloaded (a one-time notice). */
    readonly versionChanges: number;
    /** Formats an epoch time in the document language. */
    readonly time: (epochMs: number) => string;
  },
): FreshnessLine[] {
  const lines: FreshnessLine[] = [];
  const { sweptAt, expected } = freshness;
  switch (freshness.state) {
    case 'loading':
      lines.push({
        id: 'state',
        tone: 'warn',
        ...(expected === undefined
          ? {
              key: 'explorer.freshness.loadingNoExpected',
              params: { loaded: freshness.loaded },
            }
          : {
              key: 'explorer.freshness.loading',
              params: { loaded: freshness.loaded, expected },
            }),
      });
      break;
    case 'stale':
      lines.push({
        id: 'state',
        tone: 'warn',
        ...(sweptAt === undefined
          ? { key: 'explorer.freshness.staleNoTime' }
          : {
              key: 'explorer.freshness.stale',
              params: { time: options.time(sweptAt) },
            }),
      });
      break;
    case 'unavailable':
      lines.push({
        id: 'state',
        tone: 'warn',
        key: 'explorer.freshness.unavailable',
      });
      break;
    case 'live':
      if (sweptAt !== undefined) {
        lines.push({
          id: 'state',
          tone: 'info',
          key: 'explorer.freshness.updated',
          params: { time: options.time(sweptAt) },
        });
      }
      break;
  }
  if (freshness.truncated || freshness.dropped > 0) {
    const minimum =
      kind === 'bindings' &&
      freshness.reason?.includes(COUNT_NOT_KNOWN) === true;
    lines.push({
      id: 'dropped',
      tone: 'warn',
      ...(freshness.dropped === 0
        ? { key: 'explorer.freshness.truncated' }
        : minimum
          ? {
              key: 'explorer.freshness.droppedAtLeast',
              params: { dropped: freshness.dropped },
            }
          : {
              key: 'explorer.freshness.dropped',
              params: { dropped: freshness.dropped },
            }),
    });
  }
  if (!freshness.complete) {
    lines.push({
      id: 'incomplete',
      tone: 'warn',
      key: 'explorer.freshness.incomplete',
    });
  }
  if (options.versionChanges > 0 || freshness.versionChanged) {
    lines.push({
      id: 'version',
      tone: 'info',
      key: 'explorer.freshness.versionChanged',
    });
  }
  for (const id of freshness.hazards) {
    lines.push(
      isKnownHazard(id)
        ? { id: `hazard:${id}`, tone: 'info', key: `explorer.hazard.${id}` }
        : {
            id: `hazard:${id}`,
            tone: 'info',
            key: 'explorer.hazard.unknown',
            params: { id },
          },
    );
  }
  if (freshness.reason !== undefined) {
    lines.push({
      id: 'reason',
      tone: 'info',
      key: 'explorer.freshness.reason',
      engine: freshness.reason,
    });
  }
  return lines;
}

/** The live-updates part of the page: what is followed, what is paused, what ended. */
export interface LiveLine {
  readonly id: 'read' | 'live' | 'paused' | 'status';
  readonly tone: 'info' | 'warn';
  readonly key: string;
  /** What a screen reader hears when this line appears (no counts: a count is not announced again). */
  readonly announce: string;
  readonly params?: Record<string, string | number>;
  /** The Problem that ended the topic, as sent. */
  readonly problem?: ProblemView;
}

const STATUS_KEYS = ['paused', 'degraded', 'stale'] as const;

export function liveLines(
  kind: ExplorerKind,
  state: WindowSourceState | null,
): LiveLine[] {
  const lines = followLines(kind, state);
  // A window the engine refused or could not serve: its Problem as sent, until a window succeeds.
  return state !== null && state.windowError !== null
    ? [
        {
          id: 'read',
          tone: 'warn',
          key: 'explorer.freshness.readFailed',
          announce: 'explorer.announce.readFailed',
          problem: problemView(state.windowError),
        },
        ...lines,
      ]
    : lines;
}

function followLines(
  kind: ExplorerKind,
  state: WindowSourceState | null,
): LiveLine[] {
  if (kind === 'bindings') {
    return [
      {
        id: 'live',
        tone: 'info',
        key: 'explorer.live.notFollowed',
        announce: 'explorer.announce.notFollowed',
      },
    ];
  }
  if (state === null || state.live === 'off') return [];
  const lines: LiveLine[] = [];
  switch (state.live) {
    case 'connecting':
      lines.push({
        id: 'live',
        tone: 'info',
        key: 'explorer.live.connecting',
        announce: 'explorer.announce.connecting',
        params: { followed: state.followed },
      });
      break;
    case 'following':
      lines.push({
        id: 'live',
        tone: 'info',
        key: 'explorer.live.following',
        announce: 'explorer.announce.following',
        params: { followed: state.followed },
      });
      break;
    case 'ended':
      lines.push({
        id: 'live',
        tone: 'warn',
        key: 'explorer.live.ended',
        announce: 'explorer.announce.ended',
        problem: problemView(state.liveProblem),
      });
      return lines;
  }
  if (state.unfollowed > 0) {
    lines.push({
      id: 'paused',
      tone: 'warn',
      key: 'explorer.live.paused',
      announce: 'explorer.announce.paused',
      params: { unfollowed: state.unfollowed },
    });
  }
  const status = state.liveStatus;
  if (status !== null && (STATUS_KEYS as readonly string[]).includes(status)) {
    lines.push({
      id: 'status',
      tone: 'warn',
      key: `explorer.live.state.${status}`,
      announce: `explorer.announce.status.${status}`,
    });
  }
  return lines;
}

/**
 * The keys of what a screen reader hears when the state changes. They do not carry counts, so a
 * count that moves during a load does not announce again: a state is announced once.
 */
export function announcementKeys(
  freshness: Freshness | null,
  live: readonly LiveLine[],
): string[] {
  const keys: string[] = [];
  if (freshness !== null) {
    keys.push(`explorer.announce.state.${freshness.state}`);
    if (freshness.truncated || freshness.dropped > 0)
      keys.push('explorer.announce.dropped');
    if (!freshness.complete) keys.push('explorer.announce.incomplete');
  }
  for (const line of live) keys.push(line.announce);
  return keys;
}
