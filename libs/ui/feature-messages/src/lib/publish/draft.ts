// The publish draft: what the studio holds while a person composes. In memory only (R7, OQ-1518).
import type { PublishProps } from '@app/contracts';
import type { EditorLanguage } from '@app/ui-editor';

import { PUBLISH_LIMITS } from './contract-values';

import type {
  HeaderIssueCode,
  HeaderJsonError,
  HeaderRow,
} from './header-model';

export interface PublishDraft {
  readonly vhost: string;
  readonly exchange: string;
  readonly routingKey: string;
  readonly props: PublishProps;
  readonly headers: readonly HeaderRow[];
  readonly headerMode: 'grid' | 'json';
  /** Set while the headers are edited as JSON and the text is not a typed table; the rows then lag behind it. */
  readonly headerJsonError: HeaderJsonError | null;
  readonly body: {
    readonly encoding: 'utf8' | 'base64';
    readonly data: string;
    readonly language: EditorLanguage;
  };
  readonly copies: number;
  readonly timeoutMs: number;
  /** `header:<name>`, `prop:<name>` or `body`: masked in a history entry, not yet edited or acknowledged (slice F). */
  readonly masked: ReadonlySet<string>;
}

export function emptyDraft(): PublishDraft {
  return {
    vhost: '/',
    exchange: '',
    routingKey: '',
    props: {},
    headers: [],
    headerMode: 'grid',
    headerJsonError: null,
    body: { encoding: 'utf8', data: '', language: 'plaintext' },
    copies: 1,
    timeoutMs: PUBLISH_LIMITS.timeoutMsDefault,
    masked: new Set(),
  };
}

export type DraftIssueCode =
  | HeaderIssueCode
  | 'required'
  | 'out-of-range'
  | 'invalid-base64'
  | 'invalid-json'
  | 'over-limit';

/**
 * One thing that stops a send, at the field it belongs to: `vhost`, `exchange`, `routingKey`, `props.<name>`,
 * `headers` (the table) or `headers.<row id>`, `body`, `copies`, `timeoutMs`, or `form` when the contract itself
 * refuses what the checks above let through.
 */
export interface DraftIssue {
  readonly field: string;
  readonly code: DraftIssueCode | 'invalid';
  /** The largest allowed size, count, depth, length or value. */
  readonly limit?: number;
  /** The smallest allowed value of a range. */
  readonly min?: number;
  /** The header's name, for a row's problem. */
  readonly name?: string;
}
