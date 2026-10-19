// Paging of the management API (DC-48, I-7). The broker pages a list when the request carries
// `page`; a request without it answers every object, which is how a big broker brings the engine
// down. So the client always pages a list endpoint, never asks for more than the broker's own
// limit of 500 per page, and reads the answer into one `Page` shape whether the broker paged it or
// (an older release, another product) sent a bare array.
import { z } from 'zod';

/** The broker's own ceiling for `page_size`; a larger value is clamped, never sent. */
export const MAX_PAGE_SIZE = 500;
export const DEFAULT_PAGE_SIZE = 100;

/** `page_size` as the client sends it: a whole number from 1 to 500; anything else is the default. */
export function clampPageSize(requested: unknown): number {
  const size =
    typeof requested === 'number' ? requested : Number(requested ?? Number.NaN);
  if (!Number.isFinite(size) || size < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(size), MAX_PAGE_SIZE);
}

/** One page of a list, whoever answered it. */
export interface Page<T> {
  readonly items: readonly T[];
  /** 1-based. */
  readonly page: number;
  readonly pageCount: number;
  readonly pageSize: number;
  /** Objects before the name filter, and after it. */
  readonly totalCount: number;
  readonly filteredCount: number;
  readonly itemCount: number;
}

const count = z.number().int().nonnegative();

/** The broker's envelope (`rabbit_mgmt_util:paginate`). */
const envelope = <T>(item: z.ZodType<T>) =>
  z.object({
    items: z.array(item),
    page: count,
    page_count: count,
    page_size: count,
    total_count: count,
    filtered_count: count,
    item_count: count,
  });

/**
 * Reads a list answer: the paged envelope, or a bare array (one page with everything in it). An
 * unexpected shape fails the parse, so the caller sees `unexpected-body` and not a half answer.
 */
export function pagedSchema<T>(item: z.ZodType<T>): z.ZodType<Page<T>> {
  return z.union([
    envelope(item).transform(
      (body): Page<T> => ({
        items: body.items,
        page: body.page,
        pageCount: body.page_count,
        pageSize: body.page_size,
        totalCount: body.total_count,
        filteredCount: body.filtered_count,
        itemCount: body.item_count,
      }),
    ),
    z.array(item).transform(
      (items): Page<T> => ({
        items,
        page: 1,
        pageCount: 1,
        pageSize: items.length,
        totalCount: items.length,
        filteredCount: items.length,
        itemCount: items.length,
      }),
    ),
  ]);
}
