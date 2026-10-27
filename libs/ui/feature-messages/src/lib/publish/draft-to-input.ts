// The draft as the contract's publish input (R4). The studio composes; the engine decides. Every bound of the
// contract is checked here too, so a field that is over one is named before any call. `mandatory` and `confirm`
// are always true (DC-12, OQ-1438): there is nothing in the draft that could turn them off.
import type {
  ConnectionId,
  InputOf,
  messagesPublish,
  PublishProps,
} from '@app/contracts';

import {
  parsePublishInput,
  PUBLISH_LIMITS,
  publishBodyBytes,
} from './contract-values';
import type { DraftIssue, PublishDraft } from './draft';
import { rowsToHeaders } from './header-model';
import { PROP_TEXT_FIELDS } from './limits';

export type MessagesPublishInput = InputOf<typeof messagesPublish>;

export type DraftResult =
  | { readonly ok: true; readonly input: MessagesPublishInput }
  | { readonly ok: false; readonly issues: readonly DraftIssue[] };

const TEXT_MAX = PUBLISH_LIMITS.textMax;

function checkProps(props: PublishProps, issues: DraftIssue[]): PublishProps {
  const out: { -readonly [K in keyof PublishProps]: PublishProps[K] } = {};
  for (const name of PROP_TEXT_FIELDS) {
    const text = props[name];
    if (text === undefined || text === '') continue;
    if (text.length > TEXT_MAX) {
      issues.push({
        field: `props.${name}`,
        code: 'too-long',
        limit: TEXT_MAX,
      });
    } else {
      out[name] = text;
    }
  }
  if (props.deliveryMode !== undefined) out.deliveryMode = props.deliveryMode;
  const { priority, timestamp } = props;
  if (priority !== undefined) {
    if (Number.isInteger(priority) && priority >= 0 && priority <= 255) {
      out.priority = priority;
    } else {
      issues.push({
        field: 'props.priority',
        code: 'out-of-range',
        min: 0,
        limit: 255,
      });
    }
  }
  if (timestamp !== undefined) {
    if (Number.isSafeInteger(timestamp) && timestamp >= 0) {
      out.timestamp = timestamp;
    } else {
      issues.push({
        field: 'props.timestamp',
        code: 'out-of-range',
        min: 0,
        limit: Number.MAX_SAFE_INTEGER,
      });
    }
  }
  return out;
}

function checkBody(draft: PublishDraft, issues: DraftIssue[]): void {
  const bytes = publishBodyBytes(draft.body);
  if (bytes === undefined) {
    issues.push({ field: 'body', code: 'invalid-base64' });
  } else if (bytes > PUBLISH_LIMITS.bodyBytesMax) {
    issues.push({
      field: 'body',
      code: 'over-limit',
      limit: PUBLISH_LIMITS.bodyBytesMax,
    });
  }
}

function range(
  field: 'copies' | 'timeoutMs',
  value: number,
  min: number,
  max: number,
  issues: DraftIssue[],
): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    issues.push({ field, code: 'out-of-range', min, limit: max });
  }
}

export function draftToInput(
  cid: ConnectionId,
  draft: PublishDraft,
): DraftResult {
  const issues: DraftIssue[] = [];
  if (draft.vhost === '') issues.push({ field: 'vhost', code: 'required' });
  for (const field of ['vhost', 'exchange', 'routingKey'] as const) {
    if (draft[field].length > TEXT_MAX) {
      issues.push({ field, code: 'too-long', limit: TEXT_MAX });
    }
  }
  const props = checkProps(draft.props, issues);
  if (draft.headerMode === 'json' && draft.headerJsonError !== null) {
    issues.push({ field: 'headers', code: 'invalid-json' });
  }
  const headers =
    draft.headers.length === 0 ? null : rowsToHeaders(draft.headers);
  if (headers?.ok === false) {
    for (const issue of headers.issues) {
      issues.push({
        field: issue.rowId === null ? 'headers' : `headers.${issue.rowId}`,
        code: issue.code,
        ...(issue.limit === undefined ? {} : { limit: issue.limit }),
        ...(issue.rowId === null ? {} : { name: issue.name }),
      });
    }
  }
  checkBody(draft, issues);
  range('copies', draft.copies, 1, PUBLISH_LIMITS.copiesMax, issues);
  range(
    'timeoutMs',
    draft.timeoutMs,
    PUBLISH_LIMITS.timeoutMsMin,
    PUBLISH_LIMITS.timeoutMsMax,
    issues,
  );
  if (issues.length > 0) return { ok: false, issues };

  const parsed = parsePublishInput({
    cid,
    vhost: draft.vhost,
    exchange: draft.exchange,
    routingKey: draft.routingKey,
    props,
    ...(headers?.ok === true ? { headers: headers.headers } : {}),
    body: { encoding: draft.body.encoding, data: draft.body.data },
    copies: draft.copies,
    mandatory: true,
    confirm: true,
    timeoutMs: draft.timeoutMs,
  });
  return parsed.success
    ? { ok: true, input: parsed.data }
    : { ok: false, issues: [{ field: 'form', code: 'invalid' }] };
}
