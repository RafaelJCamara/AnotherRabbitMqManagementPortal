// Nodes, feature flags and deprecated features: the cluster facts of the probe (fact sheet,
// probe table 7 and 8).
import { z } from 'zod';

import { defineEndpoint } from './define.ts';

export const NodeSchema = z.object({
  name: z.string(),
  running: z.boolean().optional(),
  type: z.string().optional(),
  being_drained: z.boolean().optional(),
  enabled_plugins: z.array(z.string()).optional(),
  auth_mechanisms: z
    .array(z.object({ name: z.string(), enabled: z.boolean().optional() }))
    .optional(),
});
export type MgmtNode = z.infer<typeof NodeSchema>;

/** `columns=` keeps the node list cheap: with statistics off it is all the broker reports anyway. */
export const nodes = defineEndpoint({
  id: 'nodes.list',
  template: '/api/nodes',
  schema: z.array(NodeSchema),
  columns: [
    'name',
    'running',
    'enabled_plugins',
    'auth_mechanisms',
    'being_drained',
  ],
  stats: true,
});

export const FeatureFlagSchema = z.object({
  name: z.string(),
  state: z.string(),
  stability: z.string().optional(),
  desc: z.string().optional(),
});
export type FeatureFlag = z.infer<typeof FeatureFlagSchema>;

export const featureFlags = defineEndpoint({
  id: 'featureFlags.list',
  template: '/api/feature-flags',
  schema: z.array(FeatureFlagSchema),
});

export const DeprecatedFeatureSchema = z.object({
  name: z.string(),
  deprecation_phase: z.string().optional(),
  desc: z.string().optional(),
});
export type DeprecatedFeature = z.infer<typeof DeprecatedFeatureSchema>;

export const deprecatedFeatures = defineEndpoint({
  id: 'deprecatedFeatures.list',
  template: '/api/deprecated-features',
  schema: z.array(DeprecatedFeatureSchema),
});

/** The features this deployment still uses (the ones that matter for an upgrade). */
export const deprecatedFeaturesUsed = defineEndpoint({
  id: 'deprecatedFeatures.used',
  template: '/api/deprecated-features/used',
  schema: z.array(DeprecatedFeatureSchema),
});
