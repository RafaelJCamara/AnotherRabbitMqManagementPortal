// The shapes the connection actions share (M0-44, CON-01, CON-04). A profile has two endpoints, the
// management HTTP API and AMQP, each with its own address and its own credential (DC-37). Secrets
// are write-only (I-10): they appear in the input of a create, an update or a test (`secretInput`),
// and a client reads back only whether one is set (`SecretStatus`). Everything is bounded (I-6, I-7).
import { z } from 'zod';

import { ConnectionIdSchema } from '../brands.ts';
import { EnvClassSchema } from '../config/env.ts';
import { GateDecisionSchema } from '../errors.ts';
import { SecretStatusSchema, secretInput } from '../secret.ts';

/** The most profiles one person can see (their own and the shared ones). */
export const CONNECTIONS_PER_PRINCIPAL_MAX = 200;
/** The most profiles one `connections.list` call returns. */
export const CONNECTIONS_PAGE_MAX = 100;
/** The most listeners and tags a test reports. */
export const PROBE_FACTS_MAX = 32;

// A control character in a name or a vhost would reach logs, headers and the audit trail.
const NO_CONTROL_CHARS = /^[^\u0000-\u001f\u007f]+$/;

/** A host name or an IP address, with no port, no user and no path (so no credential can ride on it). */
export const HostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9._:-]+$/, 'A host is a name or an IP address only.');
export const PortSchema = z.number().int().min(1).max(65535);
/** An AMQP virtual host: `/` is the default one. */
export const VhostSchema = z.string().min(1).max(255).regex(NO_CONTROL_CHARS);
/** `management.path_prefix` of the broker, for example `/rabbitmq`. */
export const PathPrefixSchema = z
  .string()
  .max(200)
  .regex(
    /^\/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$/,
    'Start with / and no trailing /.',
  );
export const UsernameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(NO_CONTROL_CHARS);
export const ConnectionNameSchema = z.string().trim().min(1).max(80);
export const ColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const ConnectionVisibilitySchema = z.enum(['private', 'team']);

// ---- what a client reads ---------------------------------------------------------------------

export const HttpAuthKindSchema = z.enum(['basic', 'bearer', 'none']);
export const AmqpAuthKindSchema = z.enum(['plain', 'none']);

export const HttpEndpointSchema = z.strictObject({
  /** The management API's base URL, as derived from the fields below. It carries no credential. */
  url: z.string(),
  host: HostSchema,
  port: PortSchema,
  tls: z.boolean(),
  pathPrefix: PathPrefixSchema.nullable(),
  auth: z.strictObject({
    kind: HttpAuthKindSchema,
    username: UsernameSchema.nullable(),
    /** The password (`basic`) or the token (`bearer`): whether one is set, never the value. */
    secret: SecretStatusSchema,
  }),
});

export const AmqpEndpointSchema = z.strictObject({
  host: HostSchema,
  port: PortSchema,
  tls: z.boolean(),
  vhost: VhostSchema,
  auth: z.strictObject({
    kind: AmqpAuthKindSchema,
    username: UsernameSchema.nullable(),
    secret: SecretStatusSchema,
  }),
});

export const ConnectionProfileSchema = z.strictObject({
  id: ConnectionIdSchema,
  name: ConnectionNameSchema,
  envClass: EnvClassSchema,
  color: ColorSchema.nullable(),
  visibility: ConnectionVisibilitySchema,
  /** Whether the caller owns the profile and so may change or delete it. */
  canEdit: z.boolean(),
  http: HttpEndpointSchema,
  amqp: AmqpEndpointSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type ConnectionProfile = z.infer<typeof ConnectionProfileSchema>;

// ---- what a client writes --------------------------------------------------------------------

export const HttpAuthInputSchema = z.strictObject({
  kind: HttpAuthKindSchema,
  username: UsernameSchema.optional(),
  /** Write-only. For `basic`. */
  password: secretInput().optional(),
  /** Write-only. For `bearer`. */
  token: secretInput().optional(),
});

export const AmqpAuthInputSchema = z.strictObject({
  kind: AmqpAuthKindSchema,
  username: UsernameSchema.optional(),
  /** Write-only. */
  password: secretInput().optional(),
});

/** Every field is optional: what is left out is derived from the URI, then from the broker's defaults. */
export const HttpInputSchema = z.strictObject({
  host: HostSchema.optional(),
  port: PortSchema.optional(),
  tls: z.boolean().optional(),
  pathPrefix: PathPrefixSchema.nullable().optional(),
  auth: HttpAuthInputSchema.optional(),
});

export const AmqpInputSchema = z.strictObject({
  host: HostSchema.optional(),
  port: PortSchema.optional(),
  tls: z.boolean().optional(),
  vhost: VhostSchema.optional(),
  auth: AmqpAuthInputSchema.optional(),
});

/** The addresses and credentials of a profile, as typed or pasted. It is also what a test takes. */
export const EndpointsInputSchema = z.strictObject({
  /**
   * Write-only. A pasted `amqp://` or `amqps://` URI (user, password, host, port and vhost), or the
   * `http(s)://` URL of the management API. The URI's credentials are the AMQP credentials, and they
   * are used for the HTTP endpoint too unless `http.auth` says otherwise (OQ-440).
   */
  uri: secretInput().optional(),
  http: HttpInputSchema.optional(),
  amqp: AmqpInputSchema.optional(),
});
export type EndpointsInput = z.infer<typeof EndpointsInputSchema>;

// ---- testing an endpoint ---------------------------------------------------------------------

/** Why the HTTP test failed. Each is a different cause with a different fix. */
export const HttpTestFailureCodeSchema = z.enum([
  'HTTP_UNREACHABLE',
  'HTTP_TIMEOUT',
  'HTTP_EGRESS_DENIED',
  'HTTP_TLS_UNTRUSTED',
  'HTTP_AUTH_REFUSED',
  'HTTP_MISSING_TAG',
  'HTTP_NOT_MANAGEMENT',
  'HTTP_UNEXPECTED',
  'SECRET_UNAVAILABLE',
]);

/** Why the AMQP test failed. `AMQP_PORT_BLOCKED` is "nothing answered on that port" (refused, or no answer in time). */
export const AmqpTestFailureCodeSchema = z.enum([
  'AMQP_PORT_BLOCKED',
  'AMQP_EGRESS_DENIED',
  'AMQP_TLS_UNTRUSTED',
  'AMQP_AUTH_REFUSED',
  'AMQP_VHOST_REFUSED',
  'AMQP_UNEXPECTED',
  'SECRET_UNAVAILABLE',
]);

export const TestTargetInputSchema = z.strictObject({
  /** A saved profile, tested with its stored credentials. Give this or `draft`, not both. */
  cid: ConnectionIdSchema.optional(),
  /** A profile that is not saved yet, tested with the credentials in it. */
  draft: EndpointsInputSchema.optional(),
});

export const HttpTestOutputSchema = z.strictObject({
  ok: z.boolean(),
  /** The management URL that was tested (no credential in it). */
  target: z.strictObject({ url: z.string() }),
  tookMs: z.number().int().nonnegative(),
  failure: z
    .strictObject({ code: HttpTestFailureCodeSchema, message: z.string() })
    .optional(),
  /** What the broker said about itself, when it answered. */
  broker: z
    .strictObject({
      product: z.string().optional(),
      version: z.string().optional(),
      clusterName: z.string().optional(),
      user: z.string().optional(),
      tags: z.array(z.string()).max(PROBE_FACTS_MAX),
    })
    .optional(),
  /** The AMQP ports the broker says it listens on (`/api/overview` listeners), for the AMQP form. */
  amqpPorts: z
    .strictObject({ plain: PortSchema.nullable(), tls: PortSchema.nullable() })
    .optional(),
});

export const AmqpTestOutputSchema = z.strictObject({
  ok: z.boolean(),
  target: z.strictObject({
    host: HostSchema,
    port: PortSchema,
    tls: z.boolean(),
    vhost: VhostSchema,
  }),
  tookMs: z.number().int().nonnegative(),
  failure: z
    .strictObject({ code: AmqpTestFailureCodeSchema, message: z.string() })
    .optional(),
  /**
   * The features that need an AMQP connection, with whether they are open. When the test fails they
   * are all disabled with the reason of the failure.
   */
  gates: z.record(z.string().min(1), GateDecisionSchema),
});

// ---- bundles ---------------------------------------------------------------------------------

export const BUNDLE_FORMAT = 'connection-bundle';
export const BUNDLE_VERSION = 1;

/**
 * A profile in a bundle: addresses and user names, never a password, a token or a URI with
 * credentials. Nothing in it is write-only because nothing in it is secret.
 */
export const BundleProfileSchema = z.strictObject({
  name: ConnectionNameSchema,
  envClass: EnvClassSchema,
  color: ColorSchema.nullable(),
  http: z.strictObject({
    host: HostSchema,
    port: PortSchema,
    tls: z.boolean(),
    pathPrefix: PathPrefixSchema.nullable(),
    auth: z.strictObject({
      kind: HttpAuthKindSchema,
      username: UsernameSchema.nullable(),
    }),
  }),
  amqp: z.strictObject({
    host: HostSchema,
    port: PortSchema,
    tls: z.boolean(),
    vhost: VhostSchema,
    auth: z.strictObject({
      kind: AmqpAuthKindSchema,
      username: UsernameSchema.nullable(),
    }),
  }),
});
export type BundleProfile = z.infer<typeof BundleProfileSchema>;

export const ConnectionBundleSchema = z.strictObject({
  format: z.literal(BUNDLE_FORMAT),
  version: z.literal(BUNDLE_VERSION),
  exportedAt: z.number().int().nonnegative(),
  /** Always false in this version: see OQ-446. (A flag, because a field named for a secret is what the scanner looks for.) */
  secretsIncluded: z.literal(false),
  profiles: z.array(BundleProfileSchema).max(CONNECTIONS_PER_PRINCIPAL_MAX),
});
export type ConnectionBundle = z.infer<typeof ConnectionBundleSchema>;
