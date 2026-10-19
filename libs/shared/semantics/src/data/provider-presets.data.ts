// Provider presets: the managed-broker matrix of fact sheet j.1 (and the provider facts under it)
// as data. A preset states what the provider documents; the capability probe (j.2) measures the
// broker and wins wherever it disagrees. Where the matrix has two answers for one provider (Amazon
// MQ 3.13 against 4.2 and 4.3, the "S/P" and "B/U" cells), the base level is the weaker one and
// `overrides` raise it for the versions that are known to be better. Levels: supported, partial,
// config (needs configuration or opt-in), blocked, probe (unknown until probed).
//
// A vendor with several plans lists the same host patterns for each plan: the host does not say
// which plan it is. Every provider and every non-RabbitMQ product has a preset; `unknown` assumes
// nothing.
import type { ProviderPreset } from '../provider-presets.ts';

export const providerPresets: readonly ProviderPreset[] = [
  {
    id: 'self-hosted',
    summary: "A broker the user runs; plugins are the user's choice.",
    hostPatterns: [],
    limits: {},
    prometheus: {},
    ownedObjects: [],
    tapNeedsExplicitOverflow: false,
    httpGet: 'standard',
    support: {
      peek: 'supported',
      tap: 'supported',
      firehose: 'config',
      eventExchange: 'config',
      prometheus: 'config',
      streams: 'config',
      shovels: 'config',
      definitions: 'supported',
      operatorPolicyEdit: 'supported',
      oauth2: 'config',
    },
    citations: [
      {
        kind: 'D',
        ref: 'fact sheet section j.1, Bitnami and Kubernetes columns',
      },
    ],
  },
  {
    id: 'amazon-mq',
    summary:
      'Amazon MQ for RabbitMQ: administrator user, fixed plugin set, no event exchange, tracing or streams, low default limits on 4.x.',
    hostPatterns: ['*.mq.*.amazonaws.com', '*.mq.*.on.aws', 'vpce-*'],
    limits: { consumersPerChannelMax: 10, maxMessageBytes: 512 * 1024 },
    prometheus: {
      perObjectAllowed: false,
      minIntervalSec: 60,
      ports: [16001, 16002, 16003],
    },
    ownedObjects: [
      { kind: 'policy', pattern: 'AWS-DEFAULT-POLICY-*' },
      {
        kind: 'operator-policy',
        pattern: 'default_operator_policy_AWS_managed',
      },
      { kind: 'user', pattern: 'monitoring-AWS-OWNED-DO-NOT-DELETE' },
    ],
    // The AWS default policy sets reject-publish on every queue, so a tap must set drop-head.
    tapNeedsExplicitOverflow: true,
    httpGet: 'standard',
    support: {
      // On 4.x the default queue type is quorum with a delivery limit of 20: a high-risk peek.
      peek: 'supported',
      tap: 'partial',
      firehose: 'probe',
      eventExchange: 'blocked',
      prometheus: 'blocked',
      streams: 'blocked',
      shovels: 'partial',
      definitions: 'supported',
      operatorPolicyEdit: 'config',
      oauth2: 'supported',
    },
    overrides: [
      { versions: '<4.0.0', support: { tap: 'supported' } },
      { versions: '>=4.2.0', support: { prometheus: 'supported' } },
    ],
    citations: [
      {
        kind: 'D',
        ref: 'https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-4.html',
      },
      {
        kind: 'D',
        ref: 'https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rabbitmq-prometheus-metrics.html',
      },
      {
        kind: 'D',
        ref: 'fact sheet section j.1, Amazon MQ columns, and the provider facts under it',
      },
    ],
  },
  {
    id: 'cloudamqp-shared',
    summary:
      'CloudAMQP shared plan: a tenant vhost without administrator rights, 20 to 100 connections, 200 channels per connection and a monthly message quota that counts peeked messages.',
    hostPatterns: ['*.rmq*.cloudamqp.com'],
    limits: { connectionMax: 20, channelMax: 200 },
    toolConnectionBudget: 2,
    prometheus: {},
    ownedObjects: [],
    tapNeedsExplicitOverflow: false,
    httpGet: 'standard',
    support: {
      peek: 'partial',
      tap: 'partial',
      firehose: 'blocked',
      eventExchange: 'blocked',
      prometheus: 'blocked',
      streams: 'probe',
      shovels: 'probe',
      definitions: 'blocked',
      operatorPolicyEdit: 'probe',
      oauth2: 'blocked',
    },
    citations: [
      {
        kind: 'D',
        ref: 'fact sheet section j.1, CloudAMQP shared column and provider facts',
      },
    ],
  },
  {
    id: 'cloudamqp-dedicated',
    summary:
      'CloudAMQP dedicated plan: close to self-hosted, with the event exchange and Prometheus on by default.',
    hostPatterns: ['*.rmq*.cloudamqp.com'],
    limits: {},
    prometheus: { perObjectAllowed: true },
    ownedObjects: [],
    tapNeedsExplicitOverflow: false,
    httpGet: 'standard',
    support: {
      peek: 'supported',
      tap: 'supported',
      firehose: 'partial',
      eventExchange: 'supported',
      prometheus: 'supported',
      streams: 'config',
      shovels: 'supported',
      definitions: 'supported',
      operatorPolicyEdit: 'supported',
      oauth2: 'config',
    },
    citations: [
      { kind: 'D', ref: 'fact sheet section j.1, CloudAMQP dedicated column' },
    ],
  },
  {
    id: 'ibm',
    summary:
      'IBM Messages for RabbitMQ: fixed plugin set (no federation, Prometheus, event exchange or stream plugin) and an IBM-issued CA certificate.',
    hostPatterns: ['*.databases.appdomain.cloud'],
    limits: {},
    prometheus: {},
    ownedObjects: [],
    tapNeedsExplicitOverflow: false,
    httpGet: 'standard',
    support: {
      peek: 'supported',
      tap: 'supported',
      firehose: 'probe',
      eventExchange: 'blocked',
      prometheus: 'blocked',
      streams: 'partial',
      shovels: 'supported',
      // Allowed for the admin user, blocked for service users.
      definitions: 'partial',
      operatorPolicyEdit: 'supported',
      oauth2: 'probe',
    },
    citations: [{ kind: 'D', ref: 'fact sheet section j.1, IBM column' }],
  },
  {
    id: 'k8s-operator',
    summary:
      'RabbitMQ Cluster Operator on Kubernetes: plugins through additionalPlugins, one Service in front of the pods, the Topology Operator re-asserts its own objects.',
    hostPatterns: ['*.svc'],
    limits: {},
    prometheus: {},
    ownedObjects: [],
    tapNeedsExplicitOverflow: false,
    httpGet: 'standard',
    support: {
      peek: 'supported',
      tap: 'supported',
      firehose: 'partial',
      eventExchange: 'config',
      prometheus: 'supported',
      streams: 'config',
      shovels: 'config',
      definitions: 'supported',
      operatorPolicyEdit: 'supported',
      oauth2: 'config',
    },
    citations: [
      { kind: 'D', ref: 'fact sheet section j.1, Kubernetes operator column' },
    ],
  },
  {
    id: 'bitnami',
    summary:
      'Bitnami chart: frozen since 2025-08-28, so older brokers stay common; Prometheus on 9419 and off by default.',
    hostPatterns: [],
    limits: {},
    prometheus: { ports: [9419] },
    ownedObjects: [],
    tapNeedsExplicitOverflow: false,
    httpGet: 'standard',
    support: {
      peek: 'supported',
      tap: 'supported',
      firehose: 'partial',
      eventExchange: 'config',
      prometheus: 'config',
      streams: 'config',
      shovels: 'config',
      definitions: 'supported',
      operatorPolicyEdit: 'supported',
      oauth2: 'config',
    },
    citations: [{ kind: 'D', ref: 'fact sheet section j.1, Bitnami column' }],
  },
  {
    id: 'unknown',
    summary:
      'A provider the tool could not recognise: it assumes nothing and waits for the probe.',
    hostPatterns: [],
    limits: {},
    prometheus: {},
    ownedObjects: [],
    tapNeedsExplicitOverflow: false,
    httpGet: 'unknown',
    support: {
      peek: 'probe',
      tap: 'probe',
      firehose: 'probe',
      eventExchange: 'probe',
      prometheus: 'probe',
      streams: 'probe',
      shovels: 'probe',
      definitions: 'probe',
      operatorPolicyEdit: 'probe',
      oauth2: 'probe',
    },
    citations: [
      { kind: 'D', ref: 'fact sheet section j.2, the probe sequence' },
    ],
  },
  {
    id: 'lavinmq',
    summary:
      'LavinMQ is not RabbitMQ: no AMQP 1.0, stream protocol, firehose, event exchange, feature flags, health checks or quorum-queue endpoints. Its HTTP get route settles with reject unless the body says requeue:true.',
    hostPatterns: [],
    limits: {},
    prometheus: { ports: [15692] },
    ownedObjects: [],
    tapNeedsExplicitOverflow: false,
    httpGet: 'explicit-requeue-flag',
    support: {
      peek: 'partial',
      tap: 'supported',
      firehose: 'blocked',
      eventExchange: 'blocked',
      prometheus: 'partial',
      streams: 'partial',
      shovels: 'partial',
      definitions: 'partial',
      operatorPolicyEdit: 'supported',
      oauth2: 'config',
    },
    citations: [
      { kind: 'S', ref: 'lavinmq queues.cr@v2.10.2 L185-227' },
      { kind: 'D', ref: 'fact sheet section j.1, LavinMQ column; section b.7' },
    ],
  },
  {
    id: 'apsaramq',
    summary:
      'ApsaraMQ is not RabbitMQ: it runs in an AMQP-only mode and basic.cancel requeues messages that were already delivered.',
    hostPatterns: [],
    limits: {},
    prometheus: {},
    ownedObjects: [],
    tapNeedsExplicitOverflow: false,
    httpGet: 'unknown',
    support: {
      // A cancel that requeues delivered messages breaks the peek algorithm's release step.
      peek: 'blocked',
      tap: 'probe',
      firehose: 'probe',
      eventExchange: 'probe',
      prometheus: 'probe',
      streams: 'probe',
      shovels: 'probe',
      definitions: 'probe',
      operatorPolicyEdit: 'probe',
      oauth2: 'probe',
    },
    citations: [
      { kind: 'D', ref: 'fact sheet section j.1, provider facts (ApsaraMQ)' },
    ],
  },
];
