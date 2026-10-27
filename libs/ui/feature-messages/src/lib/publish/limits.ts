// What the form offers, in one place. The bounds themselves are the contract's (`PUBLISH_LIMITS`): the form
// mirrors them to hint and to name a field that is over one, and never to decide whether a person may publish.
import type { EditorLanguage } from '@app/ui-editor';

export { PUBLISH_LIMITS } from '@app/contracts';

/** The text properties of a message, in the order the form shows them. */
export const PROP_TEXT_FIELDS = [
  'contentType',
  'contentEncoding',
  'correlationId',
  'replyTo',
  'expiration',
  'messageId',
  'type',
  'userId',
  'appId',
] as const;
export type PropTextField = (typeof PROP_TEXT_FIELDS)[number];

/** The AMQP types of a header value. `array`, `table` and `decimal` are typed in as JSON. */
export const HEADER_TYPES = [
  'string',
  'byte',
  'short',
  'int',
  'long',
  'float',
  'double',
  'bool',
  'timestamp',
  'decimal',
  'bytes',
  'void',
  'array',
  'table',
] as const;
export type HeaderType = (typeof HEADER_TYPES)[number];

export const BODY_LANGUAGES: readonly EditorLanguage[] = [
  'plaintext',
  'json',
  'xml',
  'yaml',
];

/** How many drafts the store keeps (one per connection); the oldest goes first (I-6). */
export const DRAFT_STORE_MAX = 32;
