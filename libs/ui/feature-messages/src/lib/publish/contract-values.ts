// The one file of the studio that reads values of the contracts. The web build orders the shared contracts chunk
// by distance from the nearest entry file, and a module that imports a contract value too close to an entry (a
// lazy component, the route) would build the publish schemas before the module that switches zod's code generation
// off, which the browser reports as a Trusted Types violation (#277). Here the values are wrapped, so the files
// that need them import this one and sit at least two steps from any entry. Nothing else belongs in this file.
import {
  MessagesPublishInputSchema,
  PUBLISH_LIMITS as LIMITS,
  PublishHeaderValueSchema,
  PublishHeadersSchema,
  publishBodyBytes as bodyBytes,
} from '@app/contracts';

export const PUBLISH_LIMITS = LIMITS;

export const publishBodyBytes = (
  body: Parameters<typeof bodyBytes>[0],
): number | undefined => bodyBytes(body);

export const parsePublishInput = (raw: unknown) =>
  MessagesPublishInputSchema.safeParse(raw);

export const parseHeaderValue = (raw: unknown) =>
  PublishHeaderValueSchema.safeParse(raw);

export const parseHeaders = (raw: unknown) =>
  PublishHeadersSchema.safeParse(raw);
