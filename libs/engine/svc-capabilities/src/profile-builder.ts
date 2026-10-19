// Turns the facts of a probe into a BrokerProfile (DC-31). Every unknown is read the cautious way:
// an unreadable version is `null` (the registry then reports hazards and grants no capability), a
// product that is not RabbitMQ has no RabbitMQ version, a missing statistics flag means statistics
// are off, and a provider that the evidence does not settle is `unknown`. Version-dependent facts
// are not decided here (I-3): the era, the hazards, the capabilities and the provider limits are the
// registry's answers.
import type { ConnectionId } from '@app/contracts';
import {
  BROKER_PROFILE_SCHEMA_VERSION,
  BrokerProfileSchema,
  QueueTypeSchema,
  compareSemVer,
  lowestSemVer,
  parseSemVer,
  type BrokerProfile,
  type Provider,
  type SemVer,
} from '@app/domain-model';
import type { BrokerSemanticsRegistry } from '@app/semantics';

import { fingerprintOf } from './fingerprint';
import { isRabbitMqFamily, productOf, providerOf } from './probe/identify';
import type { Facts } from './probe/types';

/** Providers that front their clusters with a load balancer and run their own builds (fact sheet j.1). */
const MANAGED: readonly Provider[] = [
  'amazon-mq',
  'cloudamqp-shared',
  'cloudamqp-dedicated',
  'ibm',
];

/** Stands for nodes the node list did not show, because it could not be read. */
export const UNLISTED_NODES = '(nodes not listed)';
const UNKNOWN_NODE = '(unknown node)';
const DEFAULT_PROMETHEUS_INTERVAL_SEC = 15;
/** The smaller of the two documented pre-authentication frame limits: never assume more room. */
const PRE_AUTH_FRAME_MAX = 4096;

export interface BuildInput {
  readonly connectionId: ConnectionId;
  readonly probedAt: number;
  readonly facts: Facts;
  readonly registry: BrokerSemanticsRegistry;
  /** Broker versions with a green conformance run (OQ-100); none until a source exists. */
  readonly lastVerified: readonly string[];
}

const FLAG_STATES = {
  enabled: 'enabled',
  disabled: 'disabled',
} as const;

function flagsOf(
  raw: Readonly<Record<string, string>> | undefined,
): BrokerProfile['featureFlags'] {
  const out: BrokerProfile['featureFlags'] = {};
  for (const [name, state] of Object.entries(raw ?? {})) {
    out[name] =
      state === 'enabled' || state === 'disabled'
        ? FLAG_STATES[state]
        : 'unavailable';
  }
  return out;
}

function nodeVersions(facts: Facts, family: boolean) {
  const answered = new Map<string, string>();
  for (const { node, overview } of facts.overviews) {
    if (node !== undefined && overview.rabbitmq_version !== undefined) {
      answered.set(node, overview.rabbitmq_version);
    }
  }
  const names = [
    ...(facts.nodes?.map((node) => node.name) ?? []),
    ...facts.overviews.flatMap(({ node }) =>
      node === undefined ? [] : [node],
    ),
  ];
  // A cluster whose node list could not be read may have nodes nobody has looked at.
  if (family && facts.nodes === undefined) names.push(UNLISTED_NODES);
  if (names.length === 0) names.push(UNKNOWN_NODE);

  const perNode: Record<string, SemVer | null> = {};
  for (const name of new Set(names)) {
    // Only a node that answered the overview itself has a version (OQ-475).
    const text = family ? answered.get(name) : undefined;
    perNode[name] = text === undefined ? null : parseSemVer(text);
  }
  const all = Object.values(perNode);
  const known = all.filter((version): version is SemVer => version !== null);
  const first = known[0];
  return {
    perNode,
    min: known.length === all.length ? lowestSemVer(known) : null,
    mixed:
      first !== undefined &&
      known.some((version) => compareSemVer(version, first) !== 0),
  };
}

export function buildProfile(input: BuildInput): BrokerProfile {
  const { facts, registry } = input;
  const overview = facts.overviews[0]?.overview;
  const product = productOf(facts);
  const family = isRabbitMqFamily(product);
  const provider = providerOf(registry, facts);
  const versions = nodeVersions(facts, family);
  const build =
    product === 'rabbitmq' && !MANAGED.includes(provider)
      ? ('oss' as const)
      : ('commercial-or-unknown' as const);
  const featureFlags = flagsOf(facts.featureFlags);
  const ff43 = featureFlags['rabbitmq_4.3.0'];

  const statsDisabled = overview?.disable_stats ?? product !== 'lavinmq';
  const stats = {
    disabled: statsDisabled,
    queueTotals: overview?.enable_queue_totals === true,
  };
  const slice = {
    product,
    stats,
    featureFlags,
    versions: { ...versions, build },
  };

  const resolved = registry.resolveEra({
    nodeVersions: Object.values(versions.perNode),
    ff43Enabled:
      ff43 === 'enabled' ? true : ff43 === 'disabled' ? false : 'unknown',
    qqMachineVersions: [],
    build,
    lastVerified: input.lastVerified,
  });
  const eraReasons = [...resolved.reasons];
  if (!family) {
    eraReasons.push(
      `the product is ${product}: its version numbers are not RabbitMQ's, so no node has a RabbitMQ version`,
    );
  }
  if (resolved.era === '4.3' || resolved.era === '4.4') {
    eraReasons.push(
      'quorum-queue Machine Versions were not probed; the era rests on node versions and the feature flag',
    );
  }

  const preset = registry.providerPreset({ provider, product }, versions.min);
  const names = new Set(
    facts.overviews.flatMap(({ node }) => (node === undefined ? [] : [node])),
  );
  const balanced = names.size > 1 || MANAGED.includes(provider);
  const shown = [...names]
    .sort()
    .slice(0, 5)
    .map((name) => name.slice(0, 64));
  const lbEvidence = [
    names.size > 1
      ? `/api/overview was answered by ${String(names.size)} different nodes: ${shown.join(', ')}`
      : `/api/overview was answered ${String(facts.overviews.length)} time(s) by ${shown[0] ?? 'a node without a name'}`,
    ...(MANAGED.includes(provider)
      ? [
          `${provider} fronts its clusters with a load balancer (fact sheet j.1)`,
        ]
      : []),
    ...(balanced
      ? [
          'node-local results (overview, nodes, extensions, feature flags, listeners) come from one node of the cluster, not from all of it',
        ]
      : []),
  ];

  const tags = facts.identity?.tags ?? [];
  const isAdmin = tags.includes('administrator');
  const plugins = new Set((facts.nodes ?? []).flatMap((n) => n.plugins ?? []));
  const extensions = facts.extensions ?? [];
  const streamPlugin =
    plugins.has('rabbitmq_stream') || extensions.includes('stream.js');
  const operatorFlag = overview?.is_op_policy_updating_enabled;
  const queueType = QueueTypeSchema.safeParse(overview?.default_queue_type);
  const amqp = facts.amqp?.ok === true ? facts.amqp : undefined;
  const tls = facts.tls;
  const listenerProtocols = new Set(
    (overview?.listeners ?? []).map((listener) => listener.protocol),
  );

  const draft: Omit<BrokerProfile, 'probedAt' | 'fingerprint'> = {
    schemaVersion: BROKER_PROFILE_SCHEMA_VERSION,
    connectionId: input.connectionId,
    semanticsVersion: registry.version,
    product,
    provider,
    versions: { ...versions, build },
    era: {
      value: resolved.era,
      reasons: eraReasons,
      conservative: resolved.conservative || !family,
    },
    verification: resolved.verification,
    lbFronted: { value: balanced, evidence: lbEvidence },
    nodes:
      facts.nodes !== undefined
        ? [...facts.nodes]
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
            .map((node) => ({
              name: node.name,
              running: node.running,
              ...(node.beingDrained === undefined
                ? {}
                : { beingDrained: node.beingDrained }),
              ...(node.plugins === undefined
                ? {}
                : { enabledPlugins: [...node.plugins] }),
            }))
        : [...names].sort().map((name) => ({ name, running: true })),
    identity: {
      user: facts.identity?.user ?? '',
      tags: [...tags],
      isAdmin,
      canMonitor: isAdmin || tags.includes('monitoring'),
      isPolicymaker: isAdmin || tags.includes('policymaker'),
    },
    featureFlags,
    deprecatedFeaturesUsed: [...(facts.deprecatedUsed ?? [])],
    stats,
    ...(queueType.success ? { defaultQueueType: queueType.data } : {}),
    classicEnabled: 'unknown' as const,
    exchangeTypes: (overview?.exchange_types ?? [])
      .filter((type) => type.enabled !== false)
      .map((type) => type.name)
      .sort()
      .slice(0, 64),
    extensions: [...extensions],
    restrictions: {
      operatorPolicyChanges:
        operatorFlag === true
          ? ('allowed' as const)
          : operatorFlag === false ||
              preset.support.operatorPolicyEdit === 'blocked'
            ? ('disabled' as const)
            : ('unknown' as const),
      // Answering needs a write-shaped request against a queue that does not exist (j.2 step 13).
      qqReplicaOps: 'unknown' as const,
      definitionsExport:
        isAdmin && preset.support.definitions === 'supported'
          ? ('full' as const)
          : preset.support.definitions === 'partial'
            ? ('synthetic' as const)
            : ('none' as const),
    },
    limits: {
      ...(preset.limits.connectionMax === undefined
        ? {}
        : { connectionMax: preset.limits.connectionMax }),
      ...(amqp?.channelMax !== undefined && amqp.channelMax > 0
        ? { channelMax: amqp.channelMax }
        : preset.limits.channelMax === undefined
          ? {}
          : { channelMax: preset.limits.channelMax }),
      ...(preset.limits.consumersPerChannelMax === undefined
        ? {}
        : { consumersPerChannelMax: preset.limits.consumersPerChannelMax }),
      ...(preset.limits.maxMessageBytes === undefined
        ? {}
        : { maxMessageBytes: preset.limits.maxMessageBytes }),
      ...(amqp?.frameMax !== undefined && amqp.frameMax > 0
        ? { frameMax: amqp.frameMax }
        : {}),
      preAuthFrameMax: PRE_AUTH_FRAME_MAX,
    },
    prometheus: {
      endpoints: [...(facts.prometheus ?? [])],
      perObjectAllowed: preset.prometheus.perObjectAllowed ?? false,
      queueFilter: registry.capability('prometheusQueueFilter', slice),
      minIntervalSec:
        preset.prometheus.minIntervalSec ?? DEFAULT_PROMETHEUS_INTERVAL_SEC,
    },
    streams: {
      supported: family && streamPlugin && preset.support.streams !== 'blocked',
      paths:
        family && streamPlugin && preset.support.streams !== 'blocked'
          ? [
              'amqp091' as const,
              ...(listenerProtocols.has('stream')
                ? ['stream-protocol' as const]
                : []),
            ]
          : [],
      // Reaching the stream port is a socket test; none is part of this probe.
      streamProtocolReachable: 'unknown' as const,
    },
    firehose: {
      available:
        !family || preset.support.firehose === 'blocked'
          ? ('none' as const)
          : facts.exchanges?.trace === true ||
              plugins.has('rabbitmq_tracing') ||
              extensions.includes('tracing.js')
            ? ('tracing-plugin' as const)
            : ('runbook-only' as const),
    },
    auth: {
      ...(facts.oauth === undefined
        ? {}
        : {
            oauth: {
              issuer: facts.oauth.issuer,
              pinned: false,
              source: facts.oauth.source,
            },
          }),
      httpChainSeparate: 'unknown' as const,
    },
    tls:
      tls?.kind === 'checked'
        ? {
            verified: tls.verified,
            ...(tls.notAfter === undefined ? {} : { notAfter: tls.notAfter }),
            insecureOverride: tls.insecureOverride,
          }
        : { verified: false, insecureOverride: false },
    managedObjects: (facts.vendor?.objects ?? []).map((object) => ({
      kind: object.kind,
      ...(object.vhost === undefined ? {} : { vhost: object.vhost }),
      name: object.name,
      managedBy: 'provider' as const,
    })),
    hazards: registry.hazards(slice),
    // The feature gates and the era's own rules are the next work package's (M0-46).
    gates: {},
  };

  return BrokerProfileSchema.parse({
    ...draft,
    probedAt: input.probedAt,
    fingerprint: fingerprintOf(draft),
  });
}
