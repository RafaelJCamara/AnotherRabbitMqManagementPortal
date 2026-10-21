// The filter of an explorer page as chips and as edits (M0-54, R5). The filter is the contract's and
// nothing more: a case-insensitive substring of the name and the facets of `FACETS_BY_KIND`, each
// applied by the engine. There is no pattern syntax and no filtering of rows already loaded. Every
// active filter is a chip that removes itself; every cap refuses more, with a reason.
import {
  FACETS_BY_KIND,
  FILTER_CAPS,
  isFilterEmpty,
  sanitizeFilter,
  type ExplorerFilter,
  type ExplorerKind,
  type FacetName,
} from '@app/explorer-model';

import type { Translate } from '../translate';

/** The facets that hold a list of exact values. */
export type ListFacet = 'vhosts' | 'types' | 'states';

export const LIST_FACETS: readonly ListFacet[] = ['vhosts', 'types', 'states'];

/** The most values of a list facet: the contract's caps, and the explorer's own 25 vhost chips. */
export function capOf(facet: ListFacet): number {
  return facet === 'vhosts' ? FILTER_CAPS.vhostChips : FILTER_CAPS[facet];
}

/** Values offered as suggestions; the engine matches exact, case-sensitive values and any may be typed. */
export function suggestionsOf(kind: ExplorerKind, facet: ListFacet): string[] {
  if (facet === 'types') {
    if (kind === 'queues') return ['classic', 'quorum', 'stream'];
    if (kind === 'exchanges') return ['direct', 'fanout', 'topic', 'headers'];
    if (kind === 'connections') return ['AMQP 0-9-1', 'AMQP 1.0'];
  }
  if (facet === 'states') {
    if (kind === 'queues') return ['running', 'idle', 'down', 'stopped'];
    if (kind === 'connections') return ['running', 'blocked', 'blocking'];
  }
  return [];
}

export interface FilterChip {
  /** Stable, for tracking and for the accessible name. */
  readonly id: string;
  /** The words of the chip, already translated. */
  readonly text: string;
  /** The filter with this one removed. */
  readonly without: ExplorerFilter;
}

function without(
  filter: ExplorerFilter,
  facet: FacetName | 'text',
  value?: string,
): ExplorerFilter {
  const next: ExplorerFilter = { ...filter };
  if (facet === 'text') delete next.text;
  else if (facet === 'hasConsumers') delete next.hasConsumers;
  else if (facet === 'minMessages') delete next.minMessages;
  else {
    const rest = (filter[facet] ?? []).filter((v) => v !== value);
    if (facet === 'vhosts') {
      if (rest.length > 0) next.vhosts = rest;
      else delete next.vhosts;
    } else if (facet === 'types') {
      if (rest.length > 0) next.types = rest;
      else delete next.types;
    } else if (rest.length > 0) next.states = rest;
    else delete next.states;
  }
  return next;
}

/** The chips of the active filter: only the facets that apply to the kind (the others are never sent). */
export function filterChips(
  kind: ExplorerKind,
  filter: ExplorerFilter,
  t: Translate,
): FilterChip[] {
  const applied = sanitizeFilter(kind, filter);
  const chips: FilterChip[] = [];
  if (applied.text !== undefined) {
    chips.push({
      id: 'text',
      text: t('explorer.filters.chip.text', { value: applied.text }),
      without: without(applied, 'text'),
    });
  }
  for (const value of applied.vhosts ?? []) {
    chips.push({
      id: `vhosts:${value}`,
      text: t('explorer.filters.chip.vhosts', { value }),
      without: without(applied, 'vhosts', value),
    });
  }
  for (const value of applied.types ?? []) {
    chips.push({
      id: `types:${value}`,
      text: t(`explorer.filters.chip.types.${kind}`, { value }),
      without: without(applied, 'types', value),
    });
  }
  for (const value of applied.states ?? []) {
    chips.push({
      id: `states:${value}`,
      text: t('explorer.filters.chip.states', { value }),
      without: without(applied, 'states', value),
    });
  }
  if (applied.hasConsumers !== undefined) {
    chips.push({
      id: 'hasConsumers',
      text: t(
        applied.hasConsumers
          ? 'explorer.filters.chip.consumersYes'
          : 'explorer.filters.chip.consumersNo',
      ),
      without: without(applied, 'hasConsumers'),
    });
  }
  if (applied.minMessages !== undefined) {
    chips.push({
      id: 'minMessages',
      text: t('explorer.filters.chip.minMessages', {
        value: applied.minMessages,
      }),
      without: without(applied, 'minMessages'),
    });
  }
  return chips;
}

export type EditRefusal = 'text' | ListFacet;

export interface Edit {
  readonly filter: ExplorerFilter;
  /** The cap that stopped the edit; the filter is then unchanged. */
  readonly refused?: EditRefusal;
}

/** The text of the filter, cut at the contract's cap (a longer text is refused, not sent). */
export function withText(filter: ExplorerFilter, text: string): Edit {
  if (text.length > FILTER_CAPS.text) return { filter, refused: 'text' };
  const next = { ...filter };
  if (text === '') delete next.text;
  else next.text = text;
  return { filter: next };
}

/** Adds a value of a list facet; a duplicate changes nothing and a value past the cap is refused. */
export function withValue(
  filter: ExplorerFilter,
  facet: ListFacet,
  value: string,
): Edit {
  const current = filter[facet] ?? [];
  if (current.includes(value)) return { filter };
  if (current.length >= capOf(facet)) return { filter, refused: facet };
  return { filter: { ...filter, [facet]: [...current, value] } };
}

export function withoutValue(
  filter: ExplorerFilter,
  facet: ListFacet,
  value: string,
): ExplorerFilter {
  return without(filter, facet, value);
}

export function withConsumers(
  filter: ExplorerFilter,
  choice: 'any' | 'yes' | 'no',
): ExplorerFilter {
  const next = { ...filter };
  if (choice === 'any') delete next.hasConsumers;
  else next.hasConsumers = choice === 'yes';
  return next;
}

export function withMinMessages(
  filter: ExplorerFilter,
  value: number | null,
): ExplorerFilter {
  const next = { ...filter };
  if (value === null || !Number.isInteger(value) || value < 0) {
    delete next.minMessages;
  } else {
    next.minMessages = value;
  }
  return next;
}

export function activeFilter(
  kind: ExplorerKind,
  filter: ExplorerFilter,
): boolean {
  return !isFilterEmpty(sanitizeFilter(kind, filter));
}

export function facetsOf(kind: ExplorerKind): readonly FacetName[] {
  return FACETS_BY_KIND[kind];
}
