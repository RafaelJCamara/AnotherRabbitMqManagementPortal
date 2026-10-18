// The closed vocabularies of the domain model (core-interfaces.md, @app/domain-model). Branded
// identifiers (ConnectionId, FeatureId, ...) live in @app/contracts; these are the enumerated
// identifiers that name a broker era, a queue type and how far a broker build is verified.
import { z } from 'zod';

/**
 * The semantics era of a cluster. `4.0-4.2` is also the conservative era: it is the one the
 * resolver falls back to whenever it cannot prove a newer one (blueprint 5.2).
 */
export const EraSchema = z.enum(['3.13', '4.0-4.2', '4.3', '4.4']);
export type Era = z.infer<typeof EraSchema>;

/** Every era, oldest first. */
export const ERAS = EraSchema.options;

export const QueueTypeSchema = z.enum(['classic', 'quorum', 'stream']);
export type QueueType = z.infer<typeof QueueTypeSchema>;

/**
 * How far the exact broker build is covered by a green conformance run:
 * `verified` (the exact version), `unverified-patch` (same minor, another patch, for example
 * 4.3.7), `unverified-minor` (a minor with no verified version) and `unknown-build` (no public
 * tag, a commercial build, or a version that cannot be parsed).
 */
export const VerificationSchema = z.enum([
  'verified',
  'unverified-patch',
  'unverified-minor',
  'unknown-build',
]);
export type Verification = z.infer<typeof VerificationSchema>;

export const ProductSchema = z.enum([
  'rabbitmq',
  'tanzu-rabbitmq',
  'lavinmq',
  'apsaramq',
  'unknown',
]);
export type Product = z.infer<typeof ProductSchema>;

export const ProviderSchema = z.enum([
  'self-hosted',
  'amazon-mq',
  'cloudamqp-shared',
  'cloudamqp-dedicated',
  'ibm',
  'k8s-operator',
  'bitnami',
  'unknown',
]);
export type Provider = z.infer<typeof ProviderSchema>;

/** `oss` only when the build is known to be a public community release. */
export const BuildSchema = z.enum(['oss', 'commercial-or-unknown']);
export type Build = z.infer<typeof BuildSchema>;
