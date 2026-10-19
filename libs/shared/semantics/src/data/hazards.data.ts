// The known-bug table of the fact sheet (section a, "Version-specific hazards"), as data. Each rule
// names the versions it affects, the statistics or feature-flag condition when there is one, and
// where the claim comes from. A hazard is reported when it might apply: a node whose version is
// unknown is reported against every rule, and a range is written to include a build the public
// record does not cover rather than to leave it out. Every rule is `code-derived`: read from
// source, release notes and issues, never yet confirmed in the lab.
import type { HazardRule } from '../hazards.ts';

export const hazardRules: readonly HazardRule[] = [
  {
    id: 'stats-off-policy-fields-missing',
    // 3.13 up to 4.2.4. Fixed in 4.2.5 and 4.3.0.
    versions: '>=3.13.0 <4.2.5',
    statsDisabled: true,
    summary:
      'With statistics off, queues lack policy, operator_policy, effective_policy_definition and delivery_limit; compute them locally.',
    citations: [
      { kind: 'GH', ref: 'rabbitmq/rabbitmq-server#15182' },
      { kind: 'GH', ref: 'rabbitmq/rabbitmq-server#15651' },
    ],
  },
  {
    id: 'channels-400-stats-off',
    // Up to 4.3.5, and OSS 4.2.9. Fixed in 4.3.6.
    versions: '<4.3.6',
    statsDisabled: true,
    summary:
      '/api/channels answers 400 while statistics are off (and for ?disable_stats=true); do not call it.',
    citations: [
      { kind: 'GH', ref: 'rabbitmq/rabbitmq-server#17198' },
      { kind: 'D', ref: 'fact sheet section a, version-specific hazards' },
    ],
  },
  {
    id: 'passive-declare-needs-configure',
    // 4.2.6 and 4.3.0 only. Fixed in 4.2.7 and 4.3.1.
    versions: '4.2.6 || 4.3.0',
    summary:
      'A passive queue declare needs configure permission; without it the broker answers 403 and closes the channel, which returns every delivery held on it.',
    citations: [
      {
        kind: 'S',
        ref: 'rabbit_channel.erl passive declare checks, v4.2.6 and v4.3.0 (fact sheet 0.8)',
      },
    ],
  },
  {
    id: 'topic-empty-binding-key-leak',
    // 4.3.0 only. 4.3.1 fixes it behind a feature flag, see the next rule.
    versions: '4.3.0',
    summary:
      'A topic binding with key "" receives "" publishes from any topic exchange.',
    citations: [
      { kind: 'RN', ref: 'rabbitmq-server 4.3.1 release notes L23-29' },
    ],
  },
  {
    id: 'topic-empty-binding-key-leak-flag-off',
    // Fixed in 4.3.1 only together with the feature flag.
    versions: '>=4.3.1 <4.4.0',
    featureFlag: { name: 'topic_binding_projection_v5', state: 'disabled' },
    summary:
      'The topic empty-key fix of 4.3.1 needs feature flag topic_binding_projection_v5, which is disabled here.',
    citations: [
      { kind: 'RN', ref: 'rabbitmq-server 4.3.1 release notes L23-29' },
    ],
  },
  {
    id: 'chx-e2e-stale-bucket-silent-loss',
    // 4.3.0 to 4.3.5. Fixed in 4.3.6.
    versions: '>=4.3.0 <4.3.6',
    summary:
      'Deleting an exchange that is an exchange-to-exchange destination of a consistent-hash exchange leaves a stale ring bucket: silent message loss and no binding.deleted event.',
    citations: [
      { kind: 'GH', ref: 'rabbitmq/rabbitmq-server#17255' },
      { kind: 'GH', ref: 'rabbitmq/rabbitmq-server#17257' },
    ],
  },
  {
    id: 'shovel-reject-loop',
    // 4.3.0 to 4.3.6. Fixed in 4.3.7, which has no public tag yet.
    versions: '>=4.3.0 <4.3.7',
    summary:
      'A shovel treats destination rejects as non-failed returns and loops; do not use shovels to move or redrive messages.',
    citations: [{ kind: 'GH', ref: 'rabbitmq/rabbitmq-server#17794' }],
  },
  {
    id: 'amqp10-stream-filters-dropped',
    // 4.3.0 and later: the deprecated feature is denied by default and removed on main.
    versions: '>=4.3.0',
    summary:
      'Non-described rabbitmq:stream-* AMQP 1.0 filters are silently dropped unless deprecated_features.permit.amqp_filter_set_bug is true.',
    citations: [
      { kind: 'S', ref: 'rabbit_amqp_session.erl@v4.3.6 L3304-3357' },
      { kind: 'RN', ref: 'rabbitmq-server 4.3.0 release notes L139-145' },
    ],
  },
  {
    id: 'consumer-timeout-undefined-assertion',
    // 4.3.0 to 4.3.2. 4.3.3 falls back to 24 h.
    versions: '>=4.3.0 <4.3.3',
    summary:
      'consumer_timeout = undefined hits the assertion true = is_integer(MS) and fails consume and get.',
    citations: [
      { kind: 'S', ref: 'rabbit_queue_type.erl@v4.3.0 get_consumer_timeout' },
    ],
  },
  {
    id: 'vhost-put-resets-default-queue-type',
    // 4.1.4 and later.
    versions: '>=4.1.4',
    summary:
      'A vhost PUT without default_queue_type resets it to the node default; read, merge and write back.',
    citations: [
      {
        kind: 'S',
        ref: 'rabbit_vhost.erl@v4.3.6 put_vhost/update; vhost.erl L216-219',
      },
    ],
  },
  {
    id: 'vhost-put-resets-description-tags',
    // Every version.
    versions: '*',
    summary:
      'A vhost PUT without description and tags empties them; read, merge and write back.',
    citations: [
      {
        kind: 'S',
        ref: 'rabbit_mgmt_wm_vhost.erl@v4.3.6 L66-68; vhost.erl L187-196',
      },
    ],
  },
  {
    id: 'cors-unvalidated-request-headers',
    // Up to 4.2.7, and 4.3.0 to 4.3.1. Fixed in 4.2.8 and 4.3.2.
    versions: '<4.2.8 || >=4.3.0 <4.3.2',
    summary: 'CORS accepts unvalidated request headers and Origin: *.',
    citations: [{ kind: 'GH', ref: 'rabbitmq/rabbitmq-server#16544' }],
  },
  {
    id: 'oauth-client-secret-leak',
    // Up to 4.2.8, and 4.3.0 to 4.3.2. Fixed in 4.2.9 and 4.3.3.
    versions: '<4.2.9 || >=4.3.0 <4.3.3',
    summary:
      'Unauthenticated OAuth settings leak oauth_client_secret (through /api/auth up to 4.1, through bootstrap.js on 4.2 and 4.3).',
    citations: [
      { kind: 'RN', ref: 'rabbitmq-server 4.2.9 release notes L167-170' },
      { kind: 'RN', ref: 'rabbitmq-server 4.3.3 release notes L186-189' },
    ],
  },
  {
    id: 'http-log-oauth-client-id',
    // Every 4.2 and earlier build (the 4.2 backport was not merged), and 4.3.0 to 4.3.2.
    versions: '<4.3.3',
    summary:
      'The HTTP access log records OAuth users as oauth_client_id, so the audit trail cannot tell users apart.',
    citations: [
      { kind: 'RN', ref: 'rabbitmq-server 4.3.3 release notes L218-221' },
      { kind: 'GH', ref: 'rabbitmq/rabbitmq-server#16559' },
    ],
  },
  {
    id: 'delivery-limit-tick-drift-ignored',
    // 4.3.0 and later, open.
    versions: '>=4.3.0',
    summary:
      'canonicalize_delivery_limit makes tick reconciliation ignore delivery-limit drift; event-driven policy changes still apply.',
    citations: [
      {
        kind: 'S',
        ref: 'rabbit_quorum_queue.erl canonicalize_delivery_limit, v4.3.0 to v4.3.6 and main',
      },
    ],
  },
];
