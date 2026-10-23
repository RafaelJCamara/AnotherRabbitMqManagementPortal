// The DC-32 capability predicates as data: which request shapes the broker answers correctly, by
// version and statistics mode (fact sheet section f and the hazard table of section a). The mgmt
// client asks `registry.capability(id, profile)` before it sends a request; it never compares a
// version itself (I-3). A capability holds only when every node is proven inside the range.
import type { CapabilityRule } from '../capabilities.ts';

export const capabilityRules: readonly CapabilityRule[] = [
  {
    id: 'channelsAcceptDisableStats',
    summary:
      'GET /api/channels may be sent with ?disable_stats=true. Below 4.3.6 it answers 400, so the tool never sends the parameter there.',
    versions: '>=4.3.6',
    appliesWhen: 'always',
    citations: [
      { kind: 'GH', ref: 'rabbitmq/rabbitmq-server#17198' },
      { kind: 'D', ref: 'DC-32; fact sheet section f, /api/channels row' },
    ],
  },
  {
    id: 'channelsListWithStatsOff',
    summary:
      '/api/channels answers (basic information) while management statistics are off. Up to 4.3.5 it answers 400.',
    versions: '>=4.3.6',
    appliesWhen: 'stats-disabled',
    citations: [{ kind: 'GH', ref: 'rabbitmq/rabbitmq-server#17198' }],
  },
  {
    id: 'policyFieldsWithStatsOff',
    summary:
      'Queues carry policy, operator_policy, effective_policy_definition and delivery_limit while statistics are off. Below 4.2.5 they are missing, so the tool computes them itself.',
    versions: '>=4.2.5',
    appliesWhen: 'stats-disabled',
    citations: [
      { kind: 'GH', ref: 'rabbitmq/rabbitmq-server#15182' },
      { kind: 'GH', ref: 'rabbitmq/rabbitmq-server#15651' },
    ],
  },
  {
    id: 'connectionStaticInfoWithStatsOff',
    summary:
      'Connections carry peer, TLS and authentication-mechanism information while statistics are off. Up to 4.2.5 they do not.',
    versions: '>=4.2.6',
    appliesWhen: 'stats-disabled',
    citations: [{ kind: 'GH', ref: 'rabbitmq/rabbitmq-server#16009' }],
  },
  {
    id: 'enableQueueTotalsOnQueueLists',
    summary:
      'Queue lists accept ?enable_queue_totals=true, so message counts survive disable_stats.',
    versions: '>=3.13.0',
    appliesWhen: 'always',
    citations: [
      {
        kind: 'D',
        ref: 'DC-32; fact sheet section f, queue message counts row',
      },
    ],
  },
  {
    id: 'enableQueueTotalsOnSingleQueue',
    summary:
      'A single queue accepts ?enable_queue_totals=true (lists have accepted it since 3.13.0).',
    versions: '>=3.13.1',
    appliesWhen: 'always',
    citations: [
      {
        kind: 'D',
        ref: 'DC-32; fact sheet section f, queue message counts row',
      },
    ],
  },
  {
    id: 'prometheusQueueFilter',
    summary:
      '/metrics/detailed accepts queue=<regex> (one value, at most 2,000 characters; an invalid regex answers 400).',
    versions: '>=4.3.0',
    appliesWhen: 'always',
    citations: [{ kind: 'GH', ref: 'rabbitmq/rabbitmq-server#15689' }],
  },
  {
    id: 'delayedRetryArguments',
    summary: 'Queues accept the x-delayed-retry-* arguments (quorum queues).',
    versions: '>=4.3.0',
    appliesWhen: 'always',
    citations: [{ kind: 'D', ref: 'fact sheet section b.5, delayed retry' }],
  },
  {
    id: 'delayedRetryPolicyKeys',
    summary:
      'Policies accept the delayed-retry-* keys. 4.3.0 reads them but rejects them in policy validation.',
    versions: '>=4.3.1',
    appliesWhen: 'always',
    citations: [{ kind: 'RN', ref: 'rabbitmq-server 4.3.1 release notes L52' }],
  },
  {
    id: 'apiAuthEndpoint',
    summary:
      'GET /api/auth exists (up to 4.1); from 4.2 only /js/oidc-oauth/bootstrap.js publishes the OAuth settings.',
    versions: '<4.2.0',
    appliesWhen: 'always',
    citations: [
      {
        kind: 'S',
        ref: 'rabbit_mgmt_dispatcher.erl@v4.1.8 L216; absent at v4.2.9 and v4.3.6 (fact sheet 0.2)',
      },
    ],
  },
  {
    id: 'clientDeathHeaderInterpreted',
    summary:
      'The broker interprets an x-death header that a client publishes: it merges it into its own death record. From 4.0 it keeps the header opaque, delivers it verbatim and replaces it at the next dead-lettering.',
    versions: '<4.0.0',
    appliesWhen: 'always',
    citations: [
      {
        kind: 'RN',
        ref: 'rabbitmq-server 4.0.1 release notes L70-80 ("will not interpret this x-death header anymore")',
      },
      {
        kind: 'S',
        ref: 'mc_amqpl.erl@v3.13.7 L691-754 (headers_to_deaths, recover_deaths); no such code at v4.0.0',
      },
      {
        kind: 'S',
        ref: 'mc.erl@v4.3.6 L389-452 (record_death); mc_amqpl.erl@v4.3.6 L582-598 (deaths_to_headers replaces the header)',
      },
    ],
  },
];
