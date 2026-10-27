// The header table as rows a person edits, and back to the contract's typed table `{ t, v }` (R4). A row keeps
// its AMQP type; its value is the text typed in (a number, true or false, base64, or JSON for decimal, array and
// table). Nothing here guesses: a value that does not fit its type is a named problem on its row.
import {
  PUBLISH_LIMITS,
  PublishHeaderValueSchema,
  publishBodyBytes,
  type PublishHeaders,
} from '@app/contracts';

import { HEADER_TYPES, type HeaderType } from './limits';

export type HeaderValue = PublishHeaders[string];

export interface HeaderRow {
  readonly id: string;
  readonly name: string;
  readonly type: HeaderType;
  readonly text: string;
}

export type HeaderIssueCode =
  | 'name-required'
  | 'too-long'
  | 'duplicate'
  | 'bad-value'
  | 'too-many'
  | 'too-deep';

/** `rowId` is null for a problem of the table (too many rows). */
export interface HeaderIssue {
  readonly rowId: string | null;
  readonly name: string;
  readonly code: HeaderIssueCode;
  readonly limit?: number;
}

export type HeaderBuild =
  | { readonly ok: true; readonly headers: PublishHeaders }
  | { readonly ok: false; readonly issues: readonly HeaderIssue[] };

let rowCounter = 0;

export function newRow(
  name = '',
  type: HeaderType = 'string',
  text = '',
): HeaderRow {
  rowCounter += 1;
  return { id: `h${String(rowCounter)}`, name, type, text };
}

const INTEGER = /^-?\d+$/;
const DECIMAL_NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function scalar(type: HeaderType, text: string): HeaderValue | null {
  switch (type) {
    case 'string':
      return { t: 'string', v: text };
    case 'byte':
    case 'short':
    case 'int':
    case 'long':
    case 'timestamp': {
      const trimmed = text.trim();
      const number = Number(trimmed);
      return INTEGER.test(trimmed) && Number.isSafeInteger(number)
        ? { t: type, v: number }
        : null;
    }
    case 'float':
    case 'double': {
      const trimmed = text.trim();
      const number = Number(trimmed);
      return DECIMAL_NUMBER.test(trimmed) && Number.isFinite(number)
        ? { t: type, v: number }
        : null;
    }
    case 'bool': {
      const trimmed = text.trim();
      return trimmed === 'true' || trimmed === 'false'
        ? { t: 'bool', v: trimmed === 'true' }
        : null;
    }
    case 'bytes': {
      const trimmed = text.trim();
      return publishBodyBytes({ encoding: 'base64', data: trimmed }) ===
        undefined
        ? null
        : { t: 'bytes', v: trimmed };
    }
    case 'void':
      return { t: 'void', v: null };
    default:
      return null;
  }
}

/** How many lists and tables are nested in a value, counting itself; stops looking past the limit. */
export function containerDepth(value: unknown, level = 0): number {
  if (typeof value !== 'object' || value === null) return level;
  const { t, v } = value as { t?: unknown; v?: unknown };
  if ((t !== 'array' && t !== 'table') || !Array.isArray(v)) return level;
  const here = level + 1;
  if (here > PUBLISH_LIMITS.headerDepthMax) return here;
  let deepest = here;
  for (const entry of v) {
    const inner = (entry as { value?: unknown } | null)?.value;
    deepest = Math.max(deepest, containerDepth(inner, here));
  }
  return deepest;
}

function parsed(type: HeaderType, text: string): HeaderValue | null {
  if (type !== 'decimal' && type !== 'array' && type !== 'table') {
    return scalar(type, text);
  }
  try {
    return { t: type, v: JSON.parse(text) as never };
  } catch {
    return null;
  }
}

/** One row's value, or the code of what is wrong with it. */
export function rowValue(
  row: HeaderRow,
): { value: HeaderValue } | { code: 'bad-value' | 'too-deep' } {
  const value = parsed(row.type, row.text);
  if (value === null) return { code: 'bad-value' };
  if (containerDepth(value) > PUBLISH_LIMITS.headerDepthMax) {
    return { code: 'too-deep' };
  }
  return PublishHeaderValueSchema.safeParse(value).success
    ? { value }
    : { code: 'bad-value' };
}

export function rowsToHeaders(rows: readonly HeaderRow[]): HeaderBuild {
  const issues: HeaderIssue[] = [];
  const headers: Record<string, HeaderValue> = {};
  const seen = new Set<string>();
  if (rows.length > PUBLISH_LIMITS.headersMax) {
    issues.push({
      rowId: null,
      name: '',
      code: 'too-many',
      limit: PUBLISH_LIMITS.headersMax,
    });
  }
  for (const row of rows) {
    const at = { rowId: row.id, name: row.name };
    if (row.name === '') {
      issues.push({ ...at, code: 'name-required' });
    } else if (row.name.length > PUBLISH_LIMITS.textMax) {
      issues.push({ ...at, code: 'too-long', limit: PUBLISH_LIMITS.textMax });
    } else if (seen.has(row.name)) {
      issues.push({ ...at, code: 'duplicate' });
    }
    seen.add(row.name);
    const value = rowValue(row);
    if ('code' in value) {
      issues.push({
        ...at,
        code: value.code,
        ...(value.code === 'too-deep'
          ? { limit: PUBLISH_LIMITS.headerDepthMax }
          : {}),
      });
    } else {
      headers[row.name] = value.value;
    }
  }
  return issues.length === 0 ? { ok: true, headers } : { ok: false, issues };
}

function textOf(value: HeaderValue): string {
  switch (value.t) {
    case 'void':
      return '';
    case 'string':
    case 'bytes':
      return value.v;
    case 'bool':
      return value.v ? 'true' : 'false';
    case 'decimal':
    case 'array':
    case 'table':
      return JSON.stringify(value.v);
    default:
      return String(value.v);
  }
}

export function headersToRows(headers: PublishHeaders): HeaderRow[] {
  return Object.entries(headers).map(([name, value]) =>
    newRow(name, value.t, textOf(value)),
  );
}

export const isHeaderType = (value: string): value is HeaderType =>
  (HEADER_TYPES as readonly string[]).includes(value);
