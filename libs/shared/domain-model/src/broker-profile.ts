// BrokerProfile (DC-31, schemaVersion 1): what the engine knows about one connected broker, probed
// once and cached. Every consumer (planners, gates, receipts) reads facts from here and asks the
// semantics registry what they mean; nobody compares broker versions themselves (I-3).
import {
  ActionIdSchema,
  ConnectionIdSchema,
  FeatureIdSchema,
  GateDecisionSchema,
} from '@app/contracts';
import { z } from 'zod';
import {
  BuildSchema,
  EraSchema,
  ProductSchema,
  ProviderSchema,
  QueueTypeSchema,
  VerificationSchema,
} from './ids.ts';
import { SemVerSchema } from './semver.ts';

export const BROKER_PROFILE_SCHEMA_VERSION = 1;

const NodeSchema = z.strictObject({
  name: z.string(),
  running: z.boolean(),
  beingDrained: z.boolean().optional(),
  enabledPlugins: z.array(z.string()).optional(),
  /** Machine Version of this node's quorum-queue code, from the QQ status endpoint (fact sheet 0.13). */
  qqMachineVersion: z.number().int().nonnegative().optional(),
});

const Tristate = z.enum(['allowed', 'disabled', 'unknown']);

export const BrokerProfileSchema = z.strictObject({
  schemaVersion: z.literal(BROKER_PROFILE_SCHEMA_VERSION),
  connectionId: ConnectionIdSchema,
  probedAt: z.number().int().nonnegative(),
  fingerprint: z.string(),
  /** Version of the semantics registry this profile was resolved against (`sem-2026.10.1`). */
  semanticsVersion: z.string(),
  product: ProductSchema,
  provider: ProviderSchema,
  versions: z.strictObject({
    min: SemVerSchema.nullable(),
    perNode: z.record(z.string(), SemVerSchema.nullable()),
    mixed: z.boolean(),
    build: BuildSchema,
  }),
  era: z.strictObject({
    value: EraSchema,
    reasons: z.array(z.string()),
    conservative: z.boolean(),
  }),
  verification: VerificationSchema,
  lbFronted: z.strictObject({
    value: z.boolean(),
    evidence: z.array(z.string()),
  }),
  nodes: z.array(NodeSchema),
  identity: z.strictObject({
    user: z.string(),
    tags: z.array(z.string()),
    isAdmin: z.boolean(),
    canMonitor: z.boolean(),
    isPolicymaker: z.boolean(),
    protected: z.boolean().optional(),
  }),
  featureFlags: z.record(
    z.string(),
    z.enum(['enabled', 'disabled', 'unavailable']),
  ),
  deprecatedFeaturesUsed: z.array(z.string()),
  stats: z.strictObject({ disabled: z.boolean(), queueTotals: z.boolean() }),
  defaultQueueType: QueueTypeSchema.optional(),
  classicEnabled: z.union([z.boolean(), z.literal('unknown')]),
  exchangeTypes: z.array(z.string()),
  extensions: z.array(z.string()),
  restrictions: z.strictObject({
    operatorPolicyChanges: Tristate,
    qqReplicaOps: Tristate,
    definitionsExport: z.enum(['full', 'synthetic', 'none']),
  }),
  limits: z.strictObject({
    connectionMax: z.number().int().nonnegative().optional(),
    channelMax: z.number().int().nonnegative().optional(),
    consumersPerChannelMax: z.number().int().nonnegative().optional(),
    maxMessageBytes: z.number().int().nonnegative().optional(),
    frameMax: z.number().int().nonnegative().optional(),
    preAuthFrameMax: z.union([z.literal(4096), z.literal(8192)]),
  }),
  prometheus: z.strictObject({
    endpoints: z.array(
      z.strictObject({
        node: z.string(),
        url: z.string(),
        source: z.enum(['provider', 'listener', 'default', 'user']),
      }),
    ),
    perObjectAllowed: z.boolean(),
    queueFilter: z.boolean(),
    minIntervalSec: z.number().nonnegative(),
  }),
  streams: z.strictObject({
    supported: z.boolean(),
    paths: z.array(z.enum(['amqp10', 'amqp091', 'stream-protocol'])),
    streamProtocolReachable: z.union([z.boolean(), z.literal('unknown')]),
  }),
  firehose: z.strictObject({
    available: z.enum(['tracing-plugin', 'runbook-only', 'none']),
  }),
  auth: z.strictObject({
    oauth: z
      .strictObject({
        issuer: z.string(),
        pinned: z.boolean(),
        source: z.enum(['bootstrap.js', 'api/auth']),
      })
      .optional(),
    httpChainSeparate: z.union([z.boolean(), z.literal('unknown')]),
  }),
  tls: z.strictObject({
    verified: z.boolean(),
    notAfter: z.number().int().nonnegative().optional(),
    insecureOverride: z.boolean(),
  }),
  managedObjects: z.array(
    z.strictObject({
      kind: z.string(),
      vhost: z.string().optional(),
      name: z.string(),
      managedBy: z.enum([
        'servicecontrol',
        'wolverine',
        'k8s-topology-operator',
        'provider',
        'nservicebus-policy',
        'other',
      ]),
    }),
  ),
  hazards: z.array(z.string()),
  gates: z.record(FeatureIdSchema, GateDecisionSchema),
  /** Per principal and computed by the engine, so absent from a stored profile. */
  allowedActions: z.array(ActionIdSchema).optional(),
});
export type BrokerProfile = z.infer<typeof BrokerProfileSchema>;
