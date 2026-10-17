// Branded ids and the small vocabularies every contract shares (core-interfaces.md, @app/contracts).
// A brand is a zod brand, so the same type is both the static type and what the schema returns.
import { z } from 'zod';

export type Brand<T, B extends string> = T & z.$brand<B>;

const nonEmpty = z.string().min(1);

// Human-created opaque alias of a broker connection (DC-42).
export const ConnectionIdSchema = nonEmpty.brand<'ConnectionId'>();
export type ConnectionId = z.infer<typeof ConnectionIdSchema>;
export const ActionIdSchema = nonEmpty.brand<'ActionId'>();
export type ActionId = z.infer<typeof ActionIdSchema>;
export const TopicIdSchema = nonEmpty.brand<'TopicId'>();
export type TopicId = z.infer<typeof TopicIdSchema>;
export const PlanIdSchema = nonEmpty.brand<'PlanId'>();
export type PlanId = z.infer<typeof PlanIdSchema>;
export const JobIdSchema = nonEmpty.brand<'JobId'>();
export type JobId = z.infer<typeof JobIdSchema>;
export const ReceiptIdSchema = nonEmpty.brand<'ReceiptId'>();
export type ReceiptId = z.infer<typeof ReceiptIdSchema>;
export const FeatureIdSchema = nonEmpty.brand<'FeatureId'>();
export type FeatureId = z.infer<typeof FeatureIdSchema>;

/** base64url(utf8(vhost) 0x00 utf8(name)); build it with `encodeObjectKey` only. */
export const ObjectKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .brand<'ObjectKey'>();
export type ObjectKey = z.infer<typeof ObjectKeySchema>;

export const WarningIdSchema = z.templateLiteral(['W-', z.string().min(1)]);
export type WarningId = z.infer<typeof WarningIdSchema>;
export const CellIdSchema = z.templateLiteral(['SEM-', z.string().min(1)]);
export type CellId = z.infer<typeof CellIdSchema>;
export const ConformanceIdSchema = z.templateLiteral([
  'CF-',
  z.string().min(1),
]);
export type ConformanceId = z.infer<typeof ConformanceIdSchema>;

/** `<area>.<verb>`, for example `messages.purge`. */
export const PermissionSchema = z.templateLiteral([
  z.string().min(1),
  '.',
  z.string().min(1),
]);
export type Permission = z.infer<typeof PermissionSchema>;

/** Mints a branded id from a plain string; the id schemas validate it on the wire. */
export const actionId = (value: string): ActionId => value as ActionId;
export const topicId = (value: string): TopicId => value as TopicId;
