// The twelve probe steps, in the order of fact sheet j.2: network, unauthenticated, identity,
// product, features. A step reads only (GET, a TLS handshake, an AMQP handshake): none is handed a
// write port, and none sends a message.
import type { ProbeStep } from '../types';
import { tlsStep } from './01-tls';
import { hostFingerprintStep } from './02-host-fingerprint';
import { oauthDiscoveryStep } from './03-oauth-discovery';
import { identityStep } from './04-identity';
import { overviewStep } from './05-overview';
import { extensionsStep } from './06-extensions';
import { nodesStep } from './07-nodes';
import { featureFlagsStep } from './08-feature-flags';
import { vendorFingerprintsStep } from './09-vendor-fingerprints';
import { exchangesStep } from './10-exchanges';
import { prometheusStep } from './11-prometheus';
import { amqpHandshakeStep } from './12-amqp-handshake';

export const PROBE_STEPS: readonly ProbeStep[] = [
  tlsStep,
  hostFingerprintStep,
  oauthDiscoveryStep,
  identityStep,
  overviewStep,
  extensionsStep,
  nodesStep,
  featureFlagsStep,
  vendorFingerprintsStep,
  exchangesStep,
  prometheusStep,
  amqpHandshakeStep,
];
