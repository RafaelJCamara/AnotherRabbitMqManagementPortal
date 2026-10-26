// The credential-expiry, token-renewal and pre-auth frame rules (M1-23, OQ-1452) as capability
// predicates. The TokenManager of `svc-identity` asks `registry.capability(id, profile)` and never
// compares a version itself (I-3). A rule holds only while every node is proven inside the range,
// so a mixed, unreadable or unknown cluster takes the conservative side.
//
// Every rule is a source reading (docs/research/auth-network-security.md, V09, V12, V13, V41), not
// a lab result: a capability rule has no status and no evidence field, and nothing here claims
// more. The lab confirmation and the conformance cells come with M1-25 (U-14).
import type { CapabilityRule } from '../capabilities.ts';

export const authCapabilityRules: readonly CapabilityRule[] = [
  {
    id: 'amqp091ClosesAtCredentialExpiry',
    summary:
      'From 4.2.6 the broker closes an AMQP 0-9-1 connection with 320 CONNECTION_FORCED (credential expired) when its credential expires. Up to 4.2.5 the connection and its consumers stay open and later permission-checked operations fail, so the tool cancels its own consumers at expiry.',
    versions: '>=4.2.6',
    appliesWhen: 'always',
    citations: [
      {
        kind: 'D',
        ref: 'docs/research/auth-network-security.md V13 (a source reading, not a lab result; U-14)',
      },
      {
        kind: 'S',
        ref: 'RS@v4.3.6:deps/rabbit/src/rabbit_reader.erl L687-725 (closing AMQP connection: credential has expired; connection_forced); credential_expired absent at v4.2.5, present at v4.2.6 and v4.3.0 (PR #16092)',
      },
      {
        kind: 'S',
        ref: 'RS@v4.1.8:deps/rabbit/src/rabbit_channel.erl L784-797 (the tick clears the permission cache, update_user_state does not re-check consumers); deps/rabbit/Makefile L109 channel_tick_interval 60000',
      },
    ],
  },
  {
    id: 'amqp10TokenRenewalEndpoint',
    summary:
      'From 4.1.0 a client renews an AMQP 1.0 connection with PUT /auth/tokens. Up to 4.0.x the broker closes the connection at expiry and has no way to renew, so the tool reconnects with a fresh token.',
    versions: '>=4.1.0',
    appliesWhen: 'always',
    citations: [
      {
        kind: 'D',
        ref: 'docs/research/auth-network-security.md V09 and V12 (source readings, not lab results; U-14)',
      },
      {
        kind: 'S',
        ref: 'RS@v4.3.6:deps/rabbit/src/rabbit_amqp_management.erl handle_http_req PUT /auth/tokens -> rabbit_amqp_reader:set_credential; the route is absent at v4.0.9',
      },
      { kind: 'RN', ref: 'rabbitmq-server 4.1.0 release notes, #12599' },
    ],
  },
  {
    id: 'amqp091PreAuthFrame8192',
    summary:
      'From 4.1.0 the broker caps AMQP 0-9-1 frames before authentication at 8,192 bytes. Up to 4.0.x the cap is 4,096 bytes, so a token of about 4 to 8 KB sent as the PLAIN response may fail there.',
    versions: '>=4.1.0',
    appliesWhen: 'always',
    citations: [
      {
        kind: 'D',
        ref: 'docs/research/auth-network-security.md V41 (a source reading; the thresholds are recorded by M1-25, U-14)',
      },
      {
        kind: 'RN',
        ref: 'rabbitmq-server 4.1.0 release notes L45-60, L172-186, L259-262 (initial_frame_max, #13541 and #13542)',
      },
    ],
  },
];
