# Client-framework failure and dead-letter formats

> **Verified research (2026-10-16).** Source read at exact release tags and primary docs; **not yet lab-tested**. The conformance suite (M0) confirms or corrects every runtime claim. Content about a specific third-party product was removed under the docs policy ([ADR-034](../adr/ADR-034-docs-policy.md)).

_Verification task `framework-failure-formats` · 2026-10-16_

## Summary

RabbitMQ 4.x no longer interprets an x-death header that a client publishes (4.0.1 release notes). Three consequences matter for redrive:
- The stale client copy stays visible to consumers as an opaque header until the next broker dead-lettering overwrites it (mc_amqpl.erl@v4.0.9, deaths_to_headers).
- Quorum queues re-stamp x-delivery-count and x-acquired-count only after a message has been returned (rabbit_fifo_client.erl@v4.3.0), so a copied count also survives into the next delivery.
- RabbitMQ rejects any publish whose user_id property does not match the connection user.

A redrive engine must therefore strip broker-managed headers, add its own replay counter and provenance headers, and apply per-framework rules.

I read source code at release tags for more than 20 frameworks. Only about half record exception data on the message:
- **Header-based:** MassTransit (MT-Fault-*; queues {q}_error and {q}_skipped; application/vnd.masstransit+json), NServiceBus (NServiceBus.ExceptionInfo.*, FailedQ, TimeOfFailure; ServiceControl usually drains the error queue), Spring (x-exception-message, x-exception-stacktrace, x-original-exchange, x-original-routingKey), Wolverine (exception-* headers, but only with EnableEnhancedDeadLettering), Rebus (rbs2-error-details), Moleculer Channels (x-error-*), Sneakers/Kicks (retry_info).
- **Spring caveats:** since Spring AMQP 4.0.5 and 4.1.1 the stack-trace header is opt-in, and the retry-count header exists since 3.2.
- **Body-based:** EasyNetQ (a JSON Error envelope), Symfony (stamps, either as headers or inside a PHP-serialized body) and Dramatiq (options.traceback).
- **Nothing but x-death:** Celery, FastStream, NestJS, Hutch, Brighter and Laravel.

Delay and retry infrastructure must be recognised so that 'expired' deaths are not counted as failures: nsb.v2.delay-level-*, celery_delayed_*, mt-delay-*, Symfony delay_*, Laravel {q}.delay.{ms}, Sneakers {q}-retry, Dramatiq {q}.DQ.

**Delay features:**
- The official delayed-message plugin is archived (last commit 2026-09-24) and has no 4.3 build, because Mnesia was removed. A CloudAMQP fork supports 4.3.3 and later, and the MassTransit v9 docs recommend it.
- RabbitMQ 4.3 adds delayed retry for quorum queues (x-delayed-retry-*).
- RabbitMQ 4.4, not yet released, adds x-opt-delivery-time.
- None of the major frameworks uses either new feature yet.

**MassTransit v9 licensing:**
- Announced in April 2025; 9.0.0 shipped on NuGet on 2026-01-06. v9 is commercial and source-available.
- v8 stays Apache-2.0, with patches promised through at least the end of 2026; 8.5.11 shipped on 2026-09-30.
- v8 still out-downloads v9 by about 4.6 to 1 for releases published in 2026.
- The wire format is unchanged. v9 adds queue-based delayed redelivery and an early-access dashboard that can requeue faults.
- Particular offers free early-access ServicePulse support for MassTransit.

**Recommended v1 decoders:**
- **v1:** a generic broker layer, then MassTransit, Spring AMQP / Spring Cloud Stream, NServiceBus, EasyNetQ and Celery.
- **v1.1:** Symfony, Rebus, Wolverine, Laravel, Dramatiq and Sneakers.
- **Later:** everything else, through a plugin SDK.

Fingerprinting should start from ServiceControl's 'exception type + first stack frame' rule, improved by choosing the first application frame and turning the message into a template.

## Verdicts

| ID | Verdict | Confidence | Verified statement |
| --- | --- | --- | --- |
| C1-xdeath-4x | nuanced | high | Broker part confirmed: up to 3.13 RabbitMQ interpreted x-death on (re)publish. 4.x does not, but it still sets or updates x-death on every dead-lettering, including reject. A client-supplied x-death stays as an opaque header that consumers can see until the next broker dead-lettering overwrites it; x-death[0] is the most recent death. 'Frameworks keep their own retry headers' is only partly true. MassTransit (MT-Redelivery-Count, MT-Fault-RetryCount), NServiceBus (NServiceBus.Retries), Spring AMQP 3.2+ (retry-count), Celery (retries), Brighter (HandledCount), Laravel (laravel.attempts), Moleculer (x-redelivered-count) and Dramatiq (options.retries in the body) keep their own counters. Sneakers/Kicks Maxretry still counts the broker's x-death; this keeps working because the broker dead-letters on reject. Hutch, FastStream, golevelup, Wolverine native mode and Brighter's DLQ path rely only on broker DLX plus x-death. |
| C2-mt-queue-naming | confirmed | high | Confirmed. DefaultErrorQueueNameFormatter appends '_error' and DefaultDeadLetterQueueNameFormatter appends '_skipped' (v8.5.10); the v9 docs keep both. Error copies carry MT-Reason=fault. Skipped copies (no matching consumer) carry MT-Reason=dead-letter. On RabbitMQ, the error copy is published to an exchange named like the error queue, with mandatory set and a confirm awaited; the original properties are kept and Expiration is cleared. |
| C3-mt-content-type | confirmed | high | Confirmed for the default System.Text.Json envelope. The other content types are application/vnd.masstransit+bson, +xml, +msgpack, +aes and application/vnd.masstransit.v2+aes. Raw JSON uses application/json and carries identity in headers (MessageId, MT-MessageType). The envelope fields are messageId, requestId, correlationId, conversationId, initiatorId, sourceAddress, destinationAddress, responseAddress, faultAddress, messageType (urn:message:Ns:Type), message, expirationTime, sentTime, headers and host. |
| C4-mt-v9-licensing | nuanced | high | Announced around 2025-04-02 (the Q&A was updated 2025-04-03). The plan was v9 prereleases in Q3 2025 and GA in Q1 2026; NuGet 9.0.0 was published on 2026-01-06 (latest 9.2.3, 2026-10-02) with licenseUrl massient.com/license and copyright Massient, Inc. v8 stays open source under its original licences, with 'Patches and updates to v8 through at least the end of 2026' and 'After 2026: End of official maintenance'; 8.5.11 shipped on 2026-09-30. Licence terms (last updated 2026-09-17): a subscription with perpetual rights to the last licensed version, in two scopes, Single-Product Line or Organization-Wide. It is not priced by messages, endpoints or deployments. v8 is 'unsupported under this Agreement'. Organisations under USD 1M in revenue, and non-profits under USD 1M in expenses, may get a 100% discount, without commercial support. v9 is source-available, not permissively open. It needs a licence key (MT_LICENSE or MT_LICENSE_PATH). The 2025 price targets were USD 400/month (4,000/year) for SMBs and 1,200/month (12,000/year) for large organisations; current list prices render client-side and were not verified. Impact: header names and queue naming are unchanged. v9.1+ adds queue-based delayed redelivery (mt-delay-*) and 9.2.0 adds an early-access dashboard with fault requeue. v8 still dominates downloads in 2026 (MassTransit.RabbitMQ 8.5.8-8.5.10 about 6.2M versus all 9.x about 1.3M). |
| C5-particular-masstransit | confirmed | high | Confirmed. Error management for MassTransit endpoints on RabbitMQ and Azure Service Bus is in free early access (doc reviewed 2026-08-20). It runs through the ServiceControl MassTransit Connector container. The connector consumes the configured _error queues and maps MT-Fault-* headers onto NServiceBus.ExceptionInfo.*, FailedQ and TimeOfFailure. On retry it sends the message back to the last path segment of the fault input address, after removing NServiceBus.*, MT-Fault* and MT-Reason headers. The connector also creates the queues Particular.ServiceControl.Connector.MassTransit_return and Particular.ServiceControl.Connector.MassTransit_return.poison, plus error, Particular.ServiceControl, Particular.ServiceControl.staging and Particular.ServiceControl.errors. |
| C6-spring-dlq-headers | nuanced | high | Header names confirmed. Spring Cloud Stream binder 5.0.3: republishToDlq defaults to true, but it is silently disabled if the DLX is absent (autoBindDlq defaults to false). It always sets x-exception-stacktrace, truncated to frame_max minus frameMaxHeadroom (20000), plus x-exception-message (the cause's cause message), x-original-exchange and x-original-routingKey. It also increments the retry-count header and routes to DLX 'DLX' (prefixed) with routing key = queue name, into DLQ {destination}.{group}.dlq. Spring AMQP RepublishMessageRecoverer uses the same names, with the default routing key 'error.' + the original key. Its stack-trace header became opt-in (includeStackTrace(true)) in 4.0.5 and 4.1.1 (2026-08-20, issue #3518); 4.0.4 and 3.2.12 still included it. No header carries the exception class; it exists only inside the stack trace. Spring AMQP 3.2+ defines a retry-count header (MessageProperties.RETRY_COUNT). |
| C7-dme-archived-4.3 | nuanced | high | True for the official plugin. The repo is archived; its last commit, 'Update README', was on 2026-09-24 (the API does not expose an archive timestamp). The README says the plugin is no longer maintained and is based on Mnesia, which 'was completely removed... in the 4.3.0 development cycle'. The last official release is v4.2.0 (2025-11-04), and every release targets one RabbitMQ series, so there is no 4.3 build. However, a maintained CloudAMQP fork (v4.3.4, 2026-09-25) supports RabbitMQ 4.3.3+ using Khepri plus a Leveled store, and the MassTransit v9 docs recommend it. Messages delayed with the original plugin are not migrated. |
| C8-qq-delayed-retry-4.3 | confirmed | high | Confirmed. Since 4.3.0, quorum queues can hold returned messages before redelivering them. Configure it with queue arguments (x-delayed-retry-type = disabled/all/failed/returned, x-delayed-retry-min, x-delayed-retry-max) or the policy keys delayed-retry-type/-min/-max. The delay is min(min_delay * delivery_count, max_delay). 'failed' covers reject, AMQP 1.0 modified(delivery-failed=true) and channel termination; 'returned' covers nack and released. A GitHub code search found no use in MassTransit, NServiceBus, Rebus, Wolverine, EasyNetQ, kombu or Spring. It found use only in the official AMQP 1.0 clients, Bunny, bunny-rs and bunny-swift, and Foundatio.RabbitMQ. |
| C9-4.4-delayed-delivery | confirmed | high | Confirmed, but unreleased. release-notes/4.4.0.md on main says quorum queues support delayed messages through x-opt-delivery-time, in milliseconds since the epoch. AMQP 1.0 sets it as a message annotation and AMQP 0-9-1 as a long header. An AMQP 1.0 consumer can also put it on a modified outcome to delay redelivery (PR #16583). As of 2026-10-16 the newest release is v4.3.6 (2026-09-14). 4.4.0 also stops parsing the x-amqp-1.0-* 0-9-1 headers. |
| P1-servicepulse-scope | confirmed | high | Confirmed. One nuance: MassTransit is covered only through the connector container. The connector's source already contains an Amazon SQS adapter project, but the docs list only RabbitMQ and Azure Service Bus. |
| P2-hosepipe-qq-warning | confirmed | high | Confirmed. The Hosepipe wiki's EasyNetQ 9 section says RabbitMQ 4 quorum queues have a delivery limit of 20 and count messages returned when a non-destructive dump closes its channel. After 20 looks, messages are dropped. It recommends x:true (take messages off the queue) or delivery-limit -1. On 4.3, channel termination with pending messages still increments delivery-count (QQ docs), so the warning applies to 4.3 too. |
| P3-spring-custom-retry-header | nuanced | high | Spring AMQP 3.2 introduced the retry-count header (constant 'retry-count'; the 3.2 what's-new heading spells it retry_count). It is read into MessageProperties.getRetryCount() and written back when it is above 0. The Spring Cloud Stream binder increments it on republishToDlq, and the SCSt DLQ docs re-route with getRetryCount and incrementRetryCount into a {queue}.parkingLot queue. x-death is still read when present. |
| P4-xdeath-replaced | confirmed | high | Confirmed in code. When a dead-lettered message is converted for 0-9-1 delivery, deaths_to_headers overwrites the x-death value with the broker's deaths annotation, sorted most-recent-first. Until then, a 0-9-1 consumer sees the client copy. Consumers that read x-death themselves (Sneakers Maxretry, custom code) therefore see stale counts after a naive replay. |
| P5-servicepulse-grouping | confirmed | high | Confirmed. The default fingerprint is ExceptionType + ': ' + the first parsed stack frame as Type.Method(Params). The message text is removed from the ToString stack before parsing; when no frame is found the result is 'ExceptionType: No stacktrace'. The other groupers are message type, endpoint name, endpoint instance and address of the failing endpoint. |
| P6-serviceinsight-sunset | confirmed | high | Confirmed: 'ServiceInsight has been sunset and will be deprecated on February 10, 2027'; Particular recommends migrating to ServicePulse. |
| P7-warren-decoders | confirmed | medium | Confirmed, and Warren decodes only those two. The landing page lists 'Spring and MassTransit: Exception headers, _error and _skipped queues, replays back to the endpoint', plus edit-before-replay ('drop the retry counter') and parking of poison messages. It does not claim NServiceBus, EasyNetQ, Celery, Symfony or Laravel support. |
| P8-nsb-delivery-limit-policy | confirmed | high | Confirmed. NServiceBus.RabbitMQ 10+ validates the delivery limit of every consumed quorum queue. If no other policy applies to the queue, it creates the policy nsb.{queue}.delivery-limit with delivery-limit 100000, apply-to quorum_queues, priority 0 and pattern ^queue$, through the management API (policymaker tag needed). Startup fails if another policy already applies. The transport also sets client_properties client_api=NServiceBus, endpoint_name, machine_name, nservicebus_version and others. |

### Evidence

- **C1-xdeath-4x** (nuanced, high): https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.0.1.md L70-80: 'RabbitMQ 4.x will not interpret this x-death header anymore when clients (re-)publish a message... will continue to set and update the x-death header every time a message is dead-lettered'. mc_amqpl.erl@v4.0.9 (https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.0.9/deps/rabbit/src/mc_amqpl.erl) L455-456 call deaths_to_headers; L579-595 sort records by last_time, then rabbit_misc:set_table_value(Headers0, 'x-death', array, Infos), which replaces the header. kicks 3.4.0 lib/sneakers/handlers/maxretry.rb failure_count sums headers['x-death'] counts for the worker queue.
- **C2-mt-queue-naming** (confirmed, high): https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/MassTransit.Abstractions/Topology/Topology/DefaultErrorQueueNameFormatter.cs L6 'const string ErrorQueueSuffix = "_error"' and DefaultDeadLetterQueueNameFormatter.cs L6 '_skipped'; DeadLetterTransportFilter.cs L23 transport.Send(context, 'dead-letter'); RabbitMqErrorTransport.cs (CopyFrom ExceptionHeaders, ClearExpiration); https://masstransit.massient.com/concepts/exceptions
- **C3-mt-content-type** (confirmed, high): SystemTextJsonMessageSerializer.cs@v8.5.10 L20; NewtonsoftJsonMessageSerializer.cs L14; BsonMessageSerializer.cs L15; NewtonsoftXmlMessageSerializer.cs L18; EncryptedMessageSerializer.cs L10; EncryptedMessageSerializerV2.cs L9; MessagePackMessageSerializer.cs L17; SystemTextJsonRawMessageSerializer.cs L15 'application/json'; MessageEnvelope.cs; MessageUrn.cs L15 'urn:message:' (all under https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/)
- **C4-mt-v9-licensing** (nuanced, high): https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.0/doc/content/1.introduction/v9-announcement.md (transition table; 'Patches and updates to v8 through at least the end of 2026'; price targets); https://api.nuget.org/v3/catalog0/data/2026.01.06.20.13.15/masstransit.9.0.0.json ('published': '2026-01-06T20:10:16.143Z', licenseUrl https://massient.com/license); https://massient.com/license ('Last Updated: Sep 17, 2026'; section 3 'MassTransit v8 and earlier remain free and open source... unsupported under this Agreement'); https://massient.com/ FAQ; https://masstransit.massient.com/configuration/license/; NuGet registration masstransit 8.5.11 published 2026-09-30; per-version download counts from https://azuresearch-usnc.nuget.org/query?q=packageid:MassTransit.RabbitMQ
- **C5-particular-masstransit** (confirmed, high): https://raw.githubusercontent.com/Particular/docs.particular.net/master/platform/masstransit.md ('under the early access license - for free'); https://raw.githubusercontent.com/Particular/docs.particular.net/master/servicecontrol/masstransit/index.md; https://github.com/Particular/ServiceControl.Connector.MassTransit src/ServiceControl.Connector.MassTransit/MassTransitConverter.cs (From/To) and MassTransitFailureAdapter.cs (ReturnMassTransitFailure)
- **C6-spring-dlq-headers** (nuanced, high): https://raw.githubusercontent.com/spring-cloud/spring-cloud-stream/v5.0.3/binders/rabbit-binder/spring-cloud-stream-binder-rabbit/src/main/java/org/springframework/cloud/stream/binder/rabbit/RabbitMessageChannelBinder.java L728-830 (adjustMessagePropertiesHeader, incrementRetryCount) and checkDlx L865-887; RabbitConsumerProperties.java L64 'republishToDlq = true', L115 frameMaxHeadroom 20_000; RabbitExchangeQueueProvisioner.java L527-533 '.dlq' and 'DLX'; https://raw.githubusercontent.com/spring-projects/spring-amqp/v4.1.1/spring-rabbit/src/main/java/org/springframework/amqp/rabbit/retry/RepublishMessageRecoverer.java L60-88, L201-219 ('maxStackTraceLength = 0' in v4.1.1 versus '-1' in v4.0.4); https://github.com/spring-projects/spring-amqp/issues/3518; MessageProperties.java@v4.1.1 L77 RETRY_COUNT = 'retry-count'
- **C7-dme-archived-4.3** (nuanced, high): https://api.github.com/repos/rabbitmq/rabbitmq-delayed-message-exchange ('archived': true, pushed_at 2026-09-24T10:41:04Z); commits API: 068b3fac 2026-09-24 'Update README'; README 'This Project is No Longer Maintained'; releases v4.2.0 2025-11-04; https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.0/release-notes/4.3.0.md ('Mnesia was removed completely'; 'it will affect community plugins that use Mnesia'); https://github.com/cloudamqp/rabbitmq-delayed-message-exchange README ('requires RabbitMQ 4.3.3 or later'); https://masstransit.massient.com/configuration/transports/rabbitmq
- **C8-qq-delayed-retry-4.3** (confirmed, high): https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.0/release-notes/4.3.0.md L170-176; rabbit_quorum_queue.erl@v4.3.0 L562-564 (x-delayed-retry-* arguments) and L1889-1919 (get_delayed_retry_config, types all/failed/returned); https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/versioned_docs/version-4.3/quorum-queues/index.md (Delayed Retry section)
- **C9-4.4-delayed-delivery** (confirmed, high): https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.4.0.md L60-72; https://github.com/rabbitmq/rabbitmq-server/pull/16583; https://api.github.com/repos/rabbitmq/rabbitmq-server/releases (v4.3.6 published 2026-09-14T07:24:14Z)
- **P1-servicepulse-scope** (confirmed, high): https://raw.githubusercontent.com/Particular/docs.particular.net/master/platform/masstransit.md; repo tree of https://github.com/Particular/ServiceControl.Connector.MassTransit (src/ServiceControl.Connector.MassTransit.AmazonSQS/*)
- **P2-hosepipe-qq-warning** (confirmed, high): https://github.com/EasyNetQ/EasyNetQ/wiki/Re-Submitting-Error-Messages-With-EasyNetQ.Hosepipe ('Quorum error queues and the delivery limit'); https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/versioned_docs/version-4.3/quorum-queues/index.md ('failed - ... channel termination with pending messages')
- **P3-spring-custom-retry-header** (nuanced, high): https://raw.githubusercontent.com/spring-projects/spring-amqp/v4.1.1/src/reference/antora/modules/ROOT/pages/appendix/previous-whats-new/changes-in-3-2-since-3-1.adoc L14-17; DefaultMessagePropertiesConverter.java@v4.1.1 L111-115, L224-226; https://raw.githubusercontent.com/spring-cloud/spring-cloud-stream/v5.0.3/docs/modules/ROOT/pages/rabbit/rabbit_dlq.adoc L29-50
- **P4-xdeath-replaced** (confirmed, high): mc_amqpl.erl@v4.0.9 L455-456 and L579-595 (https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.0.9/deps/rabbit/src/mc_amqpl.erl)
- **P5-servicepulse-grouping** (confirmed, high): https://raw.githubusercontent.com/Particular/ServiceControl/6.21.2/src/ServiceControl/Recoverability/Grouping/Groupers/ExceptionTypeAndStackTraceFailureClassifier.cs; repo tree src/ServiceControl/Recoverability/Grouping/Groupers/*
- **P6-serviceinsight-sunset** (confirmed, high): https://raw.githubusercontent.com/Particular/docs.particular.net/master/serviceinsight/serviceinsight-sunset.include.md
- **P7-warren-decoders** (confirmed, medium): https://warrenops.io (feature grid text)
- **P8-nsb-delivery-limit-policy** (confirmed, high): https://raw.githubusercontent.com/Particular/NServiceBus.RabbitMQ/11.2.1/src/NServiceBus.Transport.RabbitMQ/Administration/BrokerVerifier.cs L191-223; Queue.cs L71 'BigValueInsteadOfActuallyUnlimited = 100_000'; Connection/ConnectionFactory.cs L93-116; https://raw.githubusercontent.com/Particular/docs.particular.net/master/transports/rabbitmq/connection-settings_delivery-limit-validation_rabbit_%5B10,%29.partial.md

## Report

# RabbitMQ framework failure, retry and dead-letter conventions

**Purpose.** This catalogue is the input for the DLQ operations centre's decoders and its redrive engine.

**Date.** 2026-10-16.

**Method.**
- The research was read-only:
  - source code read at exact release tags;
  - official docs and registry APIs.
- No broker or framework was run.
- Examples marked *illustrative* are assembled from code. Header names, types and formats are exact; the values are invented.

**Versions read:**

| Area | Versions |
| --- | --- |
| .NET | MassTransit v8.5.10, plus the v9 docs at masstransit.massient.com; NServiceBus.RabbitMQ 11.2.1; ServiceControl 6.21.2; ServiceControl.Connector.MassTransit (HEAD); Wolverine V6.51.0; Rebus 8.9.5 and Rebus.RabbitMq 10.1.2; Brighter 10.8.0; EasyNetQ 8.1.11, plus its v9 wiki |
| Java | Spring AMQP v4.1.1, compared with v4.0.4 and v4.0.5; Spring Cloud Stream v5.0.3 |
| Python | Celery v5.6.3; kombu v5.6.2; Dramatiq v2.2.1; FastStream 0.7.7 |
| PHP | Symfony v8.1.9; vyuldashev/laravel-queue-rabbitmq v15.0.2; laravel/framework v13.37.0 |
| Node | NestJS v12.1.3; @golevelup/nestjs (master); Moleculer Channels v0.3.1 |
| Go | Watermill v1.5.3; watermill-amqp v3.1.0 |
| Ruby | Kicks 3.4.0; Sneakers v2.12.0 and v2.11.0; Hutch v2.0.0 |
| RabbitMQ | v4.0.9, v4.3.0, and main (the 4.4.0 notes) |

---

## 1. Key findings

1. **Replay must strip broker-managed headers.** Three broker behaviours make this necessary:
   - **x-death is no longer interpreted.** RabbitMQ 4.x ignores an `x-death` header that a client publishes. It still records its own deaths on dead-lettering, including on reject ([4.0.1 RN](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.0.1.md) L70-80).
     - The client copy survives as an opaque header until the broker's next dead-lettering overwrites it. See `deaths_to_headers` calling `rabbit_misc:set_table_value(Headers0, <<"x-death">>, array, ...)` in [mc_amqpl.erl@v4.0.9](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.0.9/deps/rabbit/src/mc_amqpl.erl) L455-456 and L579-595.
     - Records are sorted by `last_time` and prepended, so `x-death[0]` is the most recent death.
   - **Quorum-queue counters can go stale.** Quorum queues stamp `x-acquired-count` and `x-delivery-count` only when a message has been returned at least once ([rabbit_fifo_client.erl@v4.3.0](https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.0/deps/rabbit/src/rabbit_fifo_client.erl) `add_delivery_count_header`, L243-268). A copied `x-delivery-count` therefore reaches the next consumer unchanged (*inference from code; lab test pending*). Rebus deliberately removes it before forwarding to its error queue.
   - **user_id must match.** RabbitMQ rejects a publish whose `user_id` property differs from the connection user ([validated-user-id](https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/validated-user-id.md)).
2. **About half the frameworks write exception data onto the message.**
   - **Rich data:** MassTransit, NServiceBus, Rebus, EasyNetQ (in the body), Spring (republish recoverer or binder), Sneakers/Kicks, Moleculer Channels, Symfony (stamps), Dramatiq (in the body), Watermill (an error string).
   - **Opt-in only:** Wolverine.
   - **Only `x-death`:** Celery, FastStream, NestJS, golevelup, Hutch, Brighter (outside its invalid-message channel), Laravel (the exception lives in the database), and the native-DLX modes of Spring and Wolverine.
3. **Some ecosystems drain their own dead-letter queues**, so the tool must detect them and step aside:
   - ServiceControl consumes NServiceBus `error`, and through its connector also MassTransit `_error`.
   - Wolverine `EnableDeadLetterQueueRecovery()` copies native DLQs into a database.
   - Wolverine durable endpoints, Laravel `failed_jobs` and DotNetCore.CAP keep failures in a database.
4. **Delay and retry infrastructure is everywhere**, and its `x-death` entries carry reason `expired`. These must be classified as scheduled, not failed:
   - NServiceBus `nsb.v2.delay-level-NN`;
   - Celery `celery_delayed_NN`;
   - MassTransit v9 `mt-delay-{ms}`;
   - MassTransit v8 `{exchange}_delay` (an x-delayed-message exchange);
   - Symfony `delay_*_retry`;
   - Laravel `{q}.delay.{ms}`;
   - Sneakers `{q}-retry`;
   - Dramatiq `{q}.DQ`;
   - EasyNetQ future-publish `{exchange}_{dd_hh_mm_ss}`.
5. **The official delayed-message plugin is archived.**
   - Its last commit is from 2026-09-24. There is no 4.3 build, because Mnesia was removed in 4.3.0.
   - A CloudAMQP fork (v4.3.4, 2026-09-25) supports 4.3.3 and later.
   - Frameworks that depend on the plugin:
     - **Required:** MassTransit v8 `UseDelayedRedelivery` and the delayed scheduler.
     - **Optional:** Rebus, Brighter and EasyNetQ (EasyNetQ's default scheduler uses TTL plus DLX instead).
     - **Other uses:** Spring `x-delay`, and the php-amqplib demo.
   - Native replacements:
     - 4.3 offers QQ delayed retry.
     - The unreleased 4.4 offers `x-opt-delivery-time`.
     - No major framework uses either yet.
6. **MassTransit v9 is commercial, with an unchanged wire format.**
   - Announced in April 2025; 9.0.0 on NuGet on 2026-01-06. It is source-available.
   - v8 stays Apache-2.0, with patches promised through at least the end of 2026.
   - v8 still out-downloads v9 by about 4.6 to 1 for releases published in 2026.
   - The wire format is unchanged. v9 adds `mt-delay-*` queue-based redelivery (9.1.0) and an early-access dashboard with fault requeue (9.2.0).
7. **A reference design already exists in ServiceControl.**
   - **Grouping:** `ExceptionType + ": " + first stack frame`.
   - **Retry strips** `NServiceBus.Retries*`, `NServiceBus.FailedQ`, `NServiceBus.TimeOfFailure`, `NServiceBus.ExceptionInfo.*` and `ServiceControl.EditOf`, and keeps `NServiceBus.MessageId`.
   - **Edited copies** get a new MessageId plus `ServiceControl.EditOf`.
   - **Group retries** pass through a staging queue.
   - The code is RPL-1.5 ([LICENSE](https://raw.githubusercontent.com/Particular/ServiceControl/6.21.2/LICENSE.md)). Reimplement the ideas; do not copy the code.

---

## 2. Broker-level layer that every decoder sits on

| Header or property | Set by | Behaviour in 4.x | Default replay action |
| --- | --- | --- | --- |
| `x-death` (array of tables: queue, reason, count, exchange, routing-keys, time, original-expiration) | Broker, on dead-lettering | A client copy is not interpreted and is overwritten at the next dead-lettering. `[0]` is the newest. Reasons: rejected, expired, maxlen, delivery_limit. | Strip it; keep a copy in the replay journal. |
| `x-first-death-queue/-reason/-exchange`, `x-last-death-*` | Broker | First-death values are set once. After passing through delay infrastructure they may point at a delay queue. | Strip. Never use first-death alone for routing. |
| `x-opt-deaths` | Broker (AMQP 1.0 annotation) | The AMQP 1.0 view of deaths. | Not applicable. |
| `x-delivery-count`, `x-acquired-count` (4.3+) | Broker, per quorum-queue delivery, and only after a return | A client copy survives until the first return. | Strip. |
| `expiration` property | Publisher | May already be over. MassTransit clears it when moving a message to `_error`. | Clear it, or recompute it. |
| `user_id` property | Publisher | Validated against the connection user. | Drop it unless the replay user matches or has the impersonator tag. |
| `x-delay` | Client, for an x-delayed-message exchange | Applies only to the plugin, now archived. | Strip, unless the target is a delayed exchange. |
| `x-opt-delivery-time` | Client (4.4+, quorum queues) | Native delayed delivery. | Set only for a scheduled replay. |
| `x-delayed-retry-*` arguments or policy | Operator (4.3) | Holds returned messages before redelivery. | Warn: a nack-based peek on queues with type all or returned delays those messages. |
| `x-shovelled`, `x-shovelled-timestamp`, `x-received-from` | Shovel or federation | Provenance only. | Strip by default (configurable). |

**AMQP 1.0 caveat.** Converting AMQP 0-9-1 to 1.0 drops header values that are arrays or tables unless the key starts with `x-` ([conversions.md](https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/conversions.md) L155-156).
- So Laravel's `laravel` table and Celery's `timelimit` and `stamps` are invisible to AMQP 1.0 readers.
- `x-` headers (for example Spring's `x-exception-*`) arrive as message annotations, not application properties.
- **Read dead-letter queues through AMQP 0-9-1 (amqplib), and keep the typed header tables so they round-trip unchanged.**

---

## 3. Catalogue

### 3A. Queue naming, failure headers and envelope

#### .NET

**MassTransit 8.5.10 (v9 identical per its docs)**
- **Queue naming**
  - `{q}_error`, as an exchange plus a queue.
  - `{q}_skipped`, for messages with no consumer.
  - Faults are also published as `Fault<T>` events.
- **Failure headers (AMQP type)**
  - `MT-Reason`=`fault`.
  - `MT-Fault-ExceptionType`: the base exception type.
  - `MT-Fault-InputAddress` (a URI).
  - `MT-Fault-Message`: at most 2048 characters.
  - `MT-Fault-Timestamp`: ISO-8601 "O" format.
  - `MT-Fault-StackTrace`: frames only, at most 2048 characters.
  - `MT-Fault-ConsumerType` and `MT-Fault-MessageType`.
  - All of the above are longstr.
  - `MT-Fault-RetryCount` is an int, present only when greater than 0.
  - `MT-Host-*`: eight headers.
  - Skipped messages carry `MT-Reason`=`dead-letter`.
- **Envelope and serialization**
  - `application/vnd.masstransit+json` envelope with camelCase fields, and a `messageType` of the form `urn:message:Ns:Type`.
  - Raw JSON uses `application/json`.
  - Other content types: `+bson`, `+xml`, `+msgpack`, `+aes`, `.v2+aes`.
  - AMQP `message_id` equals the MessageId.

**NServiceBus 10.2, RabbitMQ transport 11.2.1**
- **Queue naming**
  - `error` (the default) and `audit`.
  - ServiceControl drains `error`, optionally forwarding to `error.log`.
- **Failure headers (AMQP type)** — all strings:
  - `NServiceBus.ExceptionInfo.ExceptionType`.
  - `.InnerExceptionType`, `.HelpLink`, `.Message`, `.Source`.
  - `.StackTrace`, which is `Exception.ToString()`.
  - `.Data.*`.
  - `NServiceBus.FailedQ`.
  - `NServiceBus.TimeOfFailure` (`yyyy-MM-dd HH:mm:ss:ffffff Z`).
  - `NServiceBus.ProcessingEndpoint` and `NServiceBus.ProcessingMachine`.
  - `$.diagnostics.*`.
- **Envelope and serialization**
  - The body is the serialized message: `application/json`, `application/json; systemjson` or `text/xml`.
  - `NServiceBus.EnclosedMessageTypes` is assembly-qualified.
  - AMQP `message_id`=NServiceBus.MessageId.
  - `type` is the first enclosed type.
  - `content_type`=NServiceBus.ContentType, or `application/octet-stream`.

**Wolverine 6.51**
- **Queue naming**
  - `wolverine-dead-letter-queue`, using native DLX by default.
  - Can be overridden per queue.
  - Durable endpoints use the `wolverine_dead_letters` database table instead.
- **Failure headers (AMQP type)**
  - Present only with `EnableEnhancedDeadLettering()`:
    - `exception-type` (the FullName);
    - `exception-message`;
    - `exception-stack`: at most 8192 characters, followed by `... (truncated)`;
    - `failed-at`: Unix milliseconds;
    - `original-destination`, for example `rabbitmq://queue/orders`.
  - The `attempts` envelope header.
  - In native mode, only `x-death`.
- **Envelope and serialization**
  - JSON body.
  - Headers: `id`, `correlation-id`, `conversation-id`, `saga-id`, `source`, `reply-uri`, `sent-at`, `attempts`, `message-type`, `tenant-id`, and others.
  - AMQP `message_id`=the envelope GUID.
  - `type`=the message type alias.

**Rebus 8.9.5, Rebus.RabbitMq 10.1.2**
- **Queue naming**
  - `error`.
  - Exchanges are `RebusDirect` and `RebusTopics`.
- **Failure headers (AMQP type)**
  - `rbs2-error-details`, in the form `"N unhandled exceptions: <time>: <Exception.ToString()>"`, with entries separated by blank lines.
  - `rbs2-source-queue`.
  - `x-delivery-count` is removed before forwarding.
- **Envelope and serialization**
  - `rbs2-content-type` is `application/json;charset=utf-8`.
  - `rbs2-msg-id`.
  - `rbs2-msg-type`, in the form `"Ns.Type, Asm"`.
  - `rbs2-senttime` (O format).
  - `rbs2-intent` (`p2p` or `pub`).
  - `rbs2-corr-id`.
  - `rbs2-delivery-count`, taken from `x-delivery-count`.

**Brighter 10.8.0 (RMQ.Async)**
- **Queue naming**
  - A dead-letter queue the user configures, reached through native `basic.reject`.
  - A separate routing key for invalid messages.
- **Failure headers (AMQP type)**
  - For the dead-letter queue, only `x-death`.
  - The invalid-message channel adds `OriginalTopic`, `OriginalType`, `RejectionReason`, `RejectionMessage` and `RejectionTimestamp` (format "o").
- **Envelope and serialization**
  - Headers: `MessageType`, `MessageId`, `CorrelationId`, `Topic`, `HandledCount`, `x-delay`, `x-original-message-id`.
  - CloudEvents headers `cloudEvents_*`, plus `baggage`.

**EasyNetQ 8.1.11 (v9 alpha uses the same format)**
- **Queue naming**
  - `EasyNetQ_Default_Error_Queue`, reached through the direct exchange `ErrorExchange_{routingKey}`.
  - v9 applications usually name the queue, for example `billing.errors`.
- **Failure headers (AMQP type)**
  - None in headers.
  - The body is a JSON `Error`: `{RoutingKey, Exchange, Queue, Exception (ToString), Message (original body as text or Base64), DateTime, BasicProperties}`.
- **Envelope and serialization**
  - AMQP `type` is `EasyNetQ.SystemMessages.Error, EasyNetQ`; in v9 it ends `, EasyNetQ.RabbitMQ`.
  - JSON with PascalCase property names.

**DotNetCore.CAP (seen, not prioritised)**
- **Queue naming**
  - No RabbitMQ dead-letter queue; failed messages are kept in database tables.
- **Failure headers (AMQP type)**
  - `cap-exception`, stored in the database.
- **Envelope and serialization**
  - `cap-msg-id`, `cap-msg-name`, `cap-msg-group`, `cap-senttime`, `cap-corr-id`.

#### Java

**Spring AMQP 4.1.1 `RepublishMessageRecoverer`**
- **Queue naming**
  - An exchange the user chooses.
  - Default routing key `error.` followed by the original key.
- **Failure headers (AMQP type)**
  - `x-exception-message`: the cause's cause message.
  - `x-exception-stacktrace`:
    - opt-in since 4.0.5 and 4.1.1;
    - at most frame_max minus 20000 characters.
  - `x-original-exchange` and `x-original-routingKey`.
  - All of the above are longstr.
  - `retry-count` is a long (3.2+).
  - No header carries the exception class.
- **Envelope and serialization**
  - No envelope.
  - Jackson adds `__TypeId__`, `__ContentTypeId__` and `__KeyTypeId__`.
  - Compressed messages carry `content_encoding` `gzip[, enc]` and `springAutoDecompress`.

**Spring Cloud Stream 5.0.3 Rabbit binder**
- **Queue naming**
  - DLQ `{destination}.{group}.dlq` behind DLX `DLX` (prefixed).
  - The DLQ routing key is the queue name.
  - The docs suggest a `{queue}.parkingLot` pattern.
- **Failure headers (AMQP type)**
  - Set when `republishToDlq` is on (true by default; the DLX must exist).
  - `x-exception-stacktrace`, always.
  - `x-exception-message`.
  - `x-original-exchange` and `x-original-routingKey`.
  - `retry-count`, incremented.
- **Envelope and serialization**
  - As Spring AMQP.

#### Python

**Celery 5.6.3 / kombu 5.6.2**
- **Queue naming**
  - None by default.
  - A dead-letter exchange applies only when the queue is declared with one and the task rejects the message (`acks_late` with `Reject`).
- **Failure headers (AMQP type)**
  - None; the exception goes to the result backend.
- **Envelope and serialization**
  - Protocol v2 headers:
    - `lang`, `task`, `id`;
    - `shadow`, `eta`, `expires`;
    - `group`, `group_index`;
    - `retries` (int);
    - `timelimit`, an array of the form [hard, soft];
    - `root_id`, `parent_id`, `argsrepr`, `kwargsrepr`, `origin`;
    - `ignore_result`, `replaced_task_nesting`, `stamped_headers`, `stamps`;
    - `compression`.
  - `correlation_id` is the task id.
  - `content_type` is `application/json`, `x-python-serialize`, `x-yaml` or `x-msgpack`.
  - The body is `[args, kwargs, embed]`.

**Dramatiq 2.2.1**
- **Queue naming**
  - `{q}.XQ`, whose `x-message-ttl` defaults to 7 days.
- **Failure headers (AMQP type)**
  - None in headers.
  - The body holds `options.retries`, `options.traceback` (limit 30) and `options.requeue_timestamp`.
- **Envelope and serialization**
  - JSON `{queue_name, actor_name, args, kwargs, options, message_id, message_timestamp}`.
  - No `content_type`.

**FastStream 0.7.7**
- **Queue naming**
  - None.
  - The default ack policy, `REJECT_ON_ERROR`, sends failures to a DLX if one is configured.
- **Failure headers (AMQP type)**
  - Only `x-death`.
- **Envelope and serialization**
  - `content_type` is `application/json` or `text/plain`.
  - `message_id` and `correlation_id` are generated.

#### PHP

**Symfony Messenger 8.1.9 (AMQP)**
- **Queue naming**
  - A failure transport, often `failed` and often Doctrine.
  - The default exchange and queue are both named `messages`.
- **Failure headers (AMQP type)**
  - Stamps:
    - `ErrorDetailsStamp{exceptionClass, exceptionCode, exceptionMessage, flattenException}`;
    - `RedeliveryStamp{retryCount, redeliveredAt}`;
    - `SentToFailureTransportStamp{originalReceiverName}`.
  - With the Symfony Serializer they are `X-Message-Stamp-<FQCN>` JSON headers.
  - With PhpSerializer they sit inside the body.
- **Envelope and serialization**
  - PhpSerializer (the default):
    - the body is `addslashes(serialize(Envelope))`;
    - Base64 if the result is not valid UTF-8.
  - Symfony Serializer:
    - JSON body;
    - a `type` header holding the FQCN;
    - `content_type` `application/json`.

**Laravel, vyuldashev/laravel-queue-rabbitmq 15.0.2**
- **Queue naming**
  - With `reroute_failed`: DLX is `failed_exchange` (default `''`) and the routing key is `{q}.failed`.
- **Failure headers (AMQP type)**
  - None; the exception goes to the `failed_jobs` database table.
  - The `laravel` header is an AMQP table, `{attempts}`.
- **Envelope and serialization**
  - Job payload JSON:
    - `{uuid, displayName, job, maxTries, maxExceptions, failOnTimeout, backoff, timeout, retryUntil, data{commandName, command}, createdAt, id}`;
    - `command` is PHP-serialized, and may be encrypted.

**php-amqplib 3.7.x**
- **Queue naming**
  - None; it is a client library only.
- **Failure headers (AMQP type)**
  - Whatever the application adds.
- **Envelope and serialization**
  - The `demo/delayed_message.php` example relies on the archived plugin.

#### Node

**NestJS 12.1.3 RMQ**
- **Queue naming**
  - None.
  - `noAck` defaults to true, so failures are lost.
  - `persistent` defaults to false.
- **Failure headers (AMQP type)**
  - None.
- **Envelope and serialization**
  - JSON `{pattern, data, id?}`.
  - No `content_type`.

**@golevelup/nestjs-rabbitmq**
- **Queue naming**
  - None.
  - The default error behaviour is REQUEUE.
- **Failure headers (AMQP type)**
  - None.
- **Envelope and serialization**
  - Application JSON.

**Moleculer Channels 0.3.1 (AMQP)**
- **Queue naming**
  - Dead-lettering is off by default.
  - Exchange `DEAD_LETTER`, queue `FAILED_MESSAGES`.
- **Failure headers (AMQP type)**
  - `x-original-channel` and `x-original-group`.
  - `x-error-message`, `-code`, `-type`, `-name`, `-retryable`.
  - `x-error-stack` and `x-error-data`, both Base64.
  - `x-error-timestamp`, in milliseconds.
  - The original headers are dropped.
- **Envelope and serialization**
  - Queue `{group}.{channel}`.
  - `x-redelivered-count`.

#### Go

**Watermill 1.5.3 and watermill-amqp 3.1.0**
- **Queue naming**
  - A poison topic the user names.
- **Failure headers (AMQP type)**
  - `reason_poisoned`, `topic_poisoned`, `handler_poisoned`, `subscriber_poisoned`.
- **Envelope and serialization**
  - Header `_watermill_message_uuid`.
  - Watermill metadata becomes AMQP headers.

#### Ruby

**Sneakers 2.12 and Kicks 3.4.0 (Maxretry handler)**
- **Queue naming**
  - `{q}-error`, `{q}-retry` and `{q}-retry-requeue`.
- **Failure headers (AMQP type)**
  - A single `retry_info` header, holding JSON `{error, num_attempts, failed_at, properties, error_class, error_message, backtrace[10]}`.
  - Sneakers 2.11 and earlier instead sent a JSON body with Base64 payload and properties.
- **Envelope and serialization**
  - The original payload, from 2.12 on.

**Hutch 2.0.0**
- **Queue naming**
  - None.
  - Failures are nacked without requeue, which sends them to a DLX.
- **Failure headers (AMQP type)**
  - None; error handlers report to tools such as Sentry.
- **Envelope and serialization**
  - JSON.

### 3B. Retry topology, replay rules, existing tooling and adoption

Adoption figures are dated 2026-10-16. Source of each figure:

| Ecosystem | Figure | Source |
| --- | --- | --- |
| NuGet (.NET) | Total downloads | `azuresearch` query API |
| PyPI (Python) | Last month | pypistats |
| npm (Node) | 2026-09-13 to 10-12 | npm downloads API |
| Packagist (PHP) | Total and monthly | Packagist |
| RubyGems (Ruby) | Total | RubyGems API |
| GitHub | Stars | GitHub API |

Celery, NestJS and Symfony counts include users of other brokers.

#### .NET

**MassTransit**
- **Retry and delay mechanism**
  - In-memory `UseMessageRetry`.
  - `UseDelayedRedelivery`:
    - uses the x-delayed-message exchange `{exchange}_delay` with an `x-delay` header (long);
    - increments `MT-Redelivery-Count`.
  - v9.1+ `UseQueueBasedDelayedRedelivery`:
    - `mt-delay-{ms}` TTL queues;
    - a `mt-delay-return` exchange;
    - the `MT-Original-RoutingKey` header;
    - a configurable `DelayPrefix` (9.2.2).
- **Replay rule**
  - **Target:** the last path segment of `MT-Fault-InputAddress`, or the queue name minus `_error`. Send it through the default exchange or the exchange with the same name.
  - **Strip:**
    - `MT-Reason`;
    - `MT-Fault-*`;
    - the broker-managed headers.
  - **Keep:**
    - the envelope `messageId`, because the inbox locks by MessageId;
    - AMQP `message_id`.
  - **Counter:** optionally reset `MT-Redelivery-Count`.
- **Existing UI**
  - The v9 Dashboard (early access in 9.2.0):
    - fault inbox;
    - requeue a group, a single message or in bulk;
    - commercial.
  - ServicePulse through Particular's connector (free early access).
  - MassLens (12 stars).
  - The docs suggest the management UI plus a shovel.
- **Adoption**
  - MassTransit.RabbitMQ: 147.0M downloads.
  - MassTransit: 248.7M downloads.
  - 7.8k stars.

**NServiceBus**
- **Retry and delay mechanism**
  - Immediate retries run in process; on quorum queues they use `x-delivery-count`.
  - Delayed retries use 28 delay levels:
    - queues `nsb.v2.delay-level-00` to `-27`, each with TTL 2^n seconds;
    - exchange `nsb.v2.delay-delivery`;
    - routing key: 28 bits, then `.`, then the destination.
  - Version 10+ needs an unlimited delivery limit; it creates the policy `nsb.{q}.delivery-limit` (value 100000).
- **Replay rule**
  - **Target:**
    - `NServiceBus.FailedQ`, or `ServiceControl.RetryTo`;
    - for the bridge, `ServiceControl.TargetEndpointAddress`.
  - **Strip the prefixes:**
    - `NServiceBus.Retries`;
    - `NServiceBus.FailedQ`;
    - `NServiceBus.TimeOfFailure`;
    - `NServiceBus.ExceptionInfo.`;
    - `ServiceControl.EditOf`.
  - **Keep:** `NServiceBus.MessageId`, because the outbox deduplicates by MessageId.
  - **Edited copy:** a new MessageId plus `ServiceControl.EditOf`.
- **Existing UI**
  - ServicePulse and ServiceControl:
    - commercial;
    - grouping, group retry, edit and retry, redirects;
    - an audit log.
  - ServiceInsight: deprecated on 2027-02-10.
- **Adoption**
  - NServiceBus: 86.5M downloads.
  - NServiceBus.RabbitMQ: 12.5M downloads.
  - 2.2k stars.

**Wolverine**
- **Retry and delay mechanism**
  - In-process policies:
    - `RetryWithCooldown`;
    - `Requeue`;
    - `ScheduleRetry`.
  - The default is 3 attempts.
  - Failures go to the native dead-letter queue or the database dead-letter store.
  - `EnableDeadLetterQueueRecovery()` (6.9) moves native dead letters into the database.
- **Replay rule**
  - **Target:** `original-destination`, otherwise the `x-death` queue.
  - **Strip:**
    - `exception-*`;
    - `failed-at`;
    - `original-destination`.
  - **Keep:** `message_id`, because the durable inbox keeps handled ids for 5 minutes.
  - **Counter:** reset `attempts` (to be tested).
- **Existing UI**
  - `dotnet run -- storage replay [-t ExceptionType]`.
  - SQL: setting `replayable=true`.
  - CritterWatch (commercial).
  - Wolverine's own docs say: "To inspect a native transport DLQ, use that broker's own tooling."
- **Adoption**
  - WolverineFx.RabbitMQ: 2.48M downloads.
  - WolverineFx: 9.06M downloads.
  - 2.4k stars.

**Rebus**
- **Retry and delay mechanism**
  - An in-memory error tracker; 5 attempts by default.
  - Optional second-level retries via `IFailed<T>`.
  - Deferral uses either:
    - the delayed exchange (optional);
    - or a timeout manager, through `rbs2-deferred-until` and `rbs2-defer-recipient`.
- **Replay rule**
  - **Target:** `rbs2-source-queue`, through `RebusDirect` with the routing key set to the queue.
  - **Strip:**
    - `rbs2-error-details`;
    - `rbs2-source-queue`;
    - `x-delivery-count`;
    - `rbs2-delivery-count`.
  - **Keep:** `rbs2-msg-id`.
- **Existing UI**
  - Fleet Manager (Rebus Pro, commercial). It stores failures itself instead of using a dead-letter queue.
- **Adoption**
  - Rebus: 82.8M downloads.
  - Rebus.RabbitMq: 17.4M downloads.
  - 2.7k stars.

**Brighter**
- **Retry and delay mechanism**
  - Requeue republishes the message and then acks the original:
    - it increments `HandledCount`;
    - it gives the message a new id and keeps the old one in `x-original-message-id`.
  - Delayed requeue uses `x-delay` when the plugin is available, otherwise a scheduler.
  - Past the limit, the message is rejected and goes to the dead-letter queue.
- **Replay rule**
  - **Target:** the `x-death` queue.
  - **Keep:** `MessageId` and `x-original-message-id`.
  - **Counter:** reset `HandledCount`.
- **Existing UI**
  - None.
- **Adoption**
  - About 0.94M downloads (RMQ 0.81M plus RMQ.Async 0.13M).
  - 2.5k stars.

**EasyNetQ**
- **Retry and delay mechanism**
  - The error strategy acks the message and publishes an `Error` instead.
  - Future publish:
    - TTL plus DLX scheduler by default, using `{exchange}_{dd_hh_mm_ss}`;
    - or `DelayedExchangeScheduler`, which needs the plugin.
- **Replay rule**
  - **Unwrap:** take the original body and properties out of the `Error`.
  - **Publish:** to the default exchange with routing key `Error.Queue` and the mandatory flag, as Hosepipe does.
  - **Warning:** purge or ack the error queue first, otherwise duplicates appear.
- **Existing UI**
  - Hosepipe CLI.
- **Adoption**
  - 47.8M downloads.
  - 3.1k stars.

#### Java

**Spring AMQP**
- **Retry and delay mechanism**
  - An in-memory retry interceptor, followed by a recoverer:
    - `RejectAndDontRequeueRecoverer` sends the message to the DLX, with `x-death`;
    - `RepublishMessageRecoverer` adds the headers above.
  - Delayed exchange: optional.
- **Replay rule**
  - **Target, preferred:** the `x-death` queue, or the queue derived by naming convention.
  - **Target, fallback:** `x-original-exchange` plus routing key. Fan-out risk.
  - **Strip:** `x-exception-*` and `x-original-*`.
  - **Counter:** set `retry-count` according to policy.
- **Existing UI**
  - None.
- **Adoption**
  - 862 stars.
  - Maven Central publishes no download counts.

**Spring Cloud Stream**
- **Retry and delay mechanism**
  - `maxAttempts` (in memory), then republish to the DLQ or reject.
- **Replay rule**
  - **Target:** `{destination}.{group}`, that is, the DLQ name minus `.dlq`, through the default exchange (as the docs example does).
  - **Counter:** increment `retry-count`.
- **Existing UI**
  - None.
- **Adoption**
  - 1.1k stars.

#### Python

**Celery**
- **Retry and delay mechanism**
  - `Task.retry()` publishes a new message with the same id, `retries`+1 and an `eta`.
  - ETA on quorum queues uses native delayed delivery, `celery_delayed_0` to `27` (kombu 5.5 and later).
- **Replay rule**
  - **Target:** the original exchange and routing key, taken from `x-death` or from the routes.
  - **Keep:** `id`.
  - **Clear or refresh `expires`:** the worker revokes expired tasks.
  - **Counter:** optionally reset `retries`.
  - **Never unpickle** pickle payloads.
- **Existing UI**
  - Flower: task events, apply, abort and revoke. It has no dead-letter replay.
- **Adoption**
  - celery: 43.2M downloads a month.
  - Flower: 8.1M downloads a month.
  - 29k stars.

**Dramatiq**
- **Retry and delay mechanism**
  - The Retries middleware:
    - up to 20 attempts;
    - backoff from 15 seconds up to 7 days.
  - Retries go through `{q}.DQ`, where the worker holds each message until its `eta`.
  - Finally the message is nacked and goes to `{q}.XQ`.
- **Replay rule**
  - **Target:** publish the body to `{q}`.
  - **Body edits:**
    - reset `options.retries`;
    - drop `traceback`.
  - **Keep:** `message_id`.
- **Existing UI**
  - `dramatiq_dashboard`, but it supports Redis only.
- **Adoption**
  - 1.6M downloads a month.
  - 5.3k stars.

**FastStream**
- **Retry and delay mechanism**
  - None.
- **Replay rule**
  - **Target:** the `x-death` queue.
  - **Keep:** `message_id`.
- **Existing UI**
  - None.
- **Adoption**
  - 1.2M downloads a month.
  - 5.4k stars.

#### PHP

**Symfony Messenger**
- **Retry and delay mechanism**
  - The `delays` exchange routes to `delay_{ex}_{rk}_{ms}_retry` queues:
    - TTL plus `x-expires`;
    - a DLX `''`, with the routing key set to the queue.
  - Once retries are exhausted, the message goes to the failure transport.
- **Replay rule**
  - **Target:** map `originalReceiverName` to the transport's exchange or queue.
  - **Serializer format:** strip the Redelivery, ErrorDetails and SentToFailureTransport stamp headers.
  - **PhpSerializer format:** replay the body untouched, or use the Symfony CLI.
- **Existing UI**
  - CLI: `messenger:failed:show`, `retry`, `remove`.
- **Adoption**
  - amqp-messenger: 63.8M total, 1.47M a month.

**Laravel**
- **Retry and delay mechanism**
  - `release()` publishes to `{q}.delay.{ms}`:
    - TTL;
    - `x-expires` of 2 times the TTL;
    - a DLX back to the main queue.
  - On failure the message is rejected and goes to `{q}.failed`. A `failed_jobs` row is written too.
- **Replay rule**
  - **Target:** `{q}`.
  - **Counter:** set `laravel.attempts` to 0, as Laravel's own `queue:retry` does.
  - **Expiry:** refresh or clear `retryUntil`.
- **Existing UI**
  - `queue:retry` and the `failed_jobs` table.
  - Horizon supports Redis only.
- **Adoption**
  - 11.7M total, 370k a month.
  - 2.1k stars.

#### Node

**NestJS RMQ**
- **Retry and delay mechanism**
  - None.
- **Replay rule**
  - **Target:** the original queue.
- **Existing UI**
  - None.
- **Adoption**
  - `@nestjs/microservices`: 11.1M downloads a month.
  - `amqp-connection-manager`: 4.1M downloads a month.

**golevelup**
- **Retry and delay mechanism**
  - REQUEUE by default, meaning nack with requeue. On quorum queues that ends in a `delivery_limit` dead-letter or a drop.
- **Replay rule**
  - **Target:** the original queue.
- **Existing UI**
  - None.
- **Adoption**
  - 0.99M downloads a month.

**Moleculer Channels**
- **Retry and delay mechanism**
  - Republish with `x-redelivered-count`; `maxRetries` defaults to 3.
- **Replay rule**
  - **Target:** `{x-original-group}.{x-original-channel}`.
  - **Strip:** `x-error-*` and `x-original-*`.
  - **Counter:** reset the redelivery count.
- **Existing UI**
  - None.
- **Adoption**
  - Channels: 17.5k downloads a month.
  - moleculer: 280k downloads a month.

#### Go

**Watermill**
- **Retry and delay mechanism**
  - The Retry middleware runs in process.
  - PoisonQueue for exhausted messages.
  - Requeuer component:
    - tracks retries in `_watermill_requeuer_retries`;
    - delay metadata in `_watermill_delayed_until`.
- **Replay rule**
  - **Target:** `topic_poisoned`.
  - **Strip:** the `*_poisoned` headers.
- **Existing UI**
  - None.
- **Adoption**
  - 9.9k stars.

#### Ruby

**Sneakers / Kicks**
- **Retry and delay mechanism**
  - `{q}-retry`: a TTL queue, 60 seconds by default.
  - It returns messages through `{q}-retry-requeue`.
  - The retry count is the sum of `x-death` counts for the worker queue; the maximum is 5.
- **Replay rule**
  - **Target:** the worker queue.
  - **Restore:** the original properties from `retry_info.properties`.
  - **Strip:** `x-death` (Maxretry reads it) and `retry_info`.
- **Existing UI**
  - None.
- **Adoption**
  - Sneakers: 15.6M gems; last release 2019-12-24.
  - Kicks: 0.89M gems.

**Hutch**
- **Retry and delay mechanism**
  - None.
- **Replay rule**
  - **Target:** the `x-death` queue.
- **Existing UI**
  - None.
- **Adoption**
  - 3.4M gems.
  - 876 stars.

For scale:

| Library | Ecosystem | Volume |
| --- | --- | --- |
| RabbitMQ.Client | NuGet | 527.0M downloads |
| amqplib | npm | 13.6M a month |
| pika | PyPI | 10.9M a month |
| php-amqplib | Packagist | 2.9M a month |
| Bunny | RubyGems | 78.6M gems |

---

## 4. Notes and evidence for each framework

### .NET

#### MassTransit
- **Code:**
  - Exception headers are set in `SetExceptionHeaders`, using the **base** exception ([SendContextExtensions.cs@v8.5.10](https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/MassTransit.Abstractions/Contexts/SendContextExtensions.cs) L50-72).
  - Host headers are set in L16-26.
  - Names are in [MessageHeaders.cs](https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/MassTransit.Abstractions/MessageHeaders.cs).
  - Truncation to 2048 characters, and cleanup of the stack trace (it holds frames only), are in [ExceptionUtil.cs](https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/MassTransit.Abstractions/Util/ExceptionUtil.cs).
- **Moving to `_error`:**
  - [RabbitMqMoveTransport.cs](https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/Transports/MassTransit.RabbitMqTransport/RabbitMqTransport/RabbitMqMoveTransport.cs) copies the original `BasicProperties`, headers included, so `x-death` and `x-delivery-count` travel along.
  - It publishes with the mandatory flag and awaits the confirm.
  - [RabbitMqErrorTransport.cs](https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/Transports/MassTransit.RabbitMqTransport/RabbitMqTransport/RabbitMqErrorTransport.cs) calls `ClearExpiration()`.
- **Illustrative error copy:**
```
content_type: application/vnd.masstransit+json     message_id: <envelope messageId>
MT-Reason: fault
MT-Fault-ExceptionType: System.InvalidOperationException
MT-Fault-InputAddress: rabbitmq://broker/orders/submit-order
MT-Fault-Message: Order 42 was not found
MT-Fault-Timestamp: 2026-10-16T09:12:33.1234567Z
MT-Fault-StackTrace:    at Acme.SubmitOrderConsumer.Consume(ConsumeContext`1 context) ...
MT-Fault-ConsumerType: Acme.SubmitOrderConsumer     MT-Fault-MessageType: Acme.Contracts.SubmitOrder
MT-Fault-RetryCount: 5 (int)
MT-Host-MachineName / -ProcessName / -ProcessId / -Assembly / -AssemblyVersion / -MassTransitVersion / -FrameworkVersion / -OperatingSystemVersion
(+ original headers, e.g. MT-Redelivery-Count, x-death, x-delivery-count)
```
- **Delay:**
  - The plugin path uses `x-delayed-message` and the `{name}_delay` exchange name ([RabbitMqEndpointAddress.cs](https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/Transports/MassTransit.RabbitMqTransport/RabbitMqEndpointAddress.cs) L26 and L191).
  - The `x-delay` value is a long ([RabbitMqSendTransportContext.cs](https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/Transports/MassTransit.RabbitMqTransport/RabbitMqTransport/RabbitMqSendTransportContext.cs) L146-153).
  - The v8 docs say "RabbitMQ required a delayed-exchange plug-in" ([exceptions.md@v8.5.0](https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.0/doc/content/3.documentation/1.concepts/4.exceptions.md) L189).
  - v9.1.0 adds `UseQueueBasedDelayedRedelivery`, built from `mt-delay-return` and `mt-delay-{ms}` with `MT-Original-RoutingKey`. v9.2.2 adds `DelayPrefix` ([v9 redelivery docs](https://masstransit.massient.com/configuration/middleware/redelivery)).
  - The v9 docs recommend the CloudAMQP plugin fork ([v9 RabbitMQ docs](https://masstransit.massient.com/configuration/transports/rabbitmq)).
- **Deduplication:** "the inbox is used to lock the message by MessageId" ([transactional-outbox.md@v8.5.0](https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.0/doc/content/3.documentation/3.patterns/11.transactional-outbox.md) L39). Preserve the MessageId on replay.
- **v9 Dashboard (early access in 9.2.0):** the fault inbox and requeue actions read messages through the **management HTTP API** ([dashboard docs](https://masstransit.massient.com/configuration/dashboard/)). That API reads by getting and requeuing, so the same side-effect hazards apply on quorum queues.
- **Connection name:** `ClientProvidedName` defaults to the process name ([ConfigurationHostSettings.cs](https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/Transports/MassTransit.RabbitMqTransport/RabbitMqTransport/Configuration/ConfigurationHostSettings.cs) L35).

#### NServiceBus, ServiceControl and ServicePulse
- **Real error headers** (docs, NServiceBus 10.2.0; [headers](https://docs.particular.net/nservicebus/messaging/headers)):
```
NServiceBus.ExceptionInfo.Data.Handler type = Core.Headers.Writers.MyNamespace.MessageHandler
NServiceBus.ExceptionInfo.ExceptionType = System.Exception
NServiceBus.ExceptionInfo.Message = The exception message from the handler.
NServiceBus.ExceptionInfo.Source = Core_10
NServiceBus.ExceptionInfo.StackTrace = System.Exception: The exception message from the handler.
      at Core.Headers.Writers.HeaderWriterError.MessageHandler.Handle(...)
NServiceBus.FailedQ = HeaderWriterError
NServiceBus.MessageId = eb8cf6f5-6817-4e9f-ba8e-b43b016c458a
NServiceBus.ProcessingEndpoint = HeaderWriterError
NServiceBus.TimeOfFailure = 2026-04-29 22:06:16:406166 Z
NServiceBus.ContentType = application/json
```
- **Retry headers:** `NServiceBus.Retries` and `.Retries.Timestamp` exist during delayed retries ([headers.md](https://raw.githubusercontent.com/Particular/docs.particular.net/master/nservicebus/messaging/headers.md) L351-364). The docs say they are removed before the message moves to the error queue.
- **Transport mapping:** see [BasicPropertiesExtensions.cs@11.2.1](https://raw.githubusercontent.com/Particular/NServiceBus.RabbitMQ/11.2.1/src/NServiceBus.Transport.RabbitMQ/Sending/BasicPropertiesExtensions.cs). The delay header is `NServiceBus.Transport.RabbitMQ.DelayInSeconds` ([DelayInfrastructure.cs](https://raw.githubusercontent.com/Particular/NServiceBus.RabbitMQ/11.2.1/src/NServiceBus.Transport.RabbitMQ/DelayedDelivery/DelayInfrastructure.cs)).
- **Delay design:** 28 levels with binary routing keys ([delayed-delivery.md](https://raw.githubusercontent.com/Particular/docs.particular.net/master/transports/rabbitmq/delayed-delivery.md)). Shovels do not understand this layout; use the `delays transfer` command instead.
- **Retry rules:**
  - [HeaderFilter.cs@6.21.2](https://raw.githubusercontent.com/Particular/ServiceControl/6.21.2/src/ServiceControl/Recoverability/Retrying/HeaderFilter.cs) lists the headers stripped on retry.
  - [ReturnToSender.cs](https://raw.githubusercontent.com/Particular/ServiceControl/6.21.2/src/ServiceControl/Recoverability/Retrying/Infrastructure/ReturnToSender.cs) picks the destination: `ServiceControl.TargetEndpointAddress`, or `ServiceControl.RetryTo`.
  - The unique id is `DeterministicGuid(MessageId, ProcessingEndpoint)` ([TransportMessageExtensions.cs](https://raw.githubusercontent.com/Particular/ServiceControl/6.21.2/src/ServiceControl/Infrastructure/TransportMessageExtensions.cs)).
  - Edits get a new MessageId plus `ServiceControl.EditOf` ([EditHandler.cs](https://raw.githubusercontent.com/Particular/ServiceControl/6.21.2/src/ServiceControl/Recoverability/Editing/EditHandler.cs) L54 and L83-85; [editing docs](https://raw.githubusercontent.com/Particular/docs.particular.net/master/servicepulse/intro-editing-messages.md)).
- **Outbox deduplicates by MessageId** ([outbox](https://raw.githubusercontent.com/Particular/docs.particular.net/master/nservicebus/outbox/index.md) L95).
- **Ingestion:** ServiceControl ingests from `error`, with optional forwarding to `<ErrorQueue>.log` ([configuration.md](https://raw.githubusercontent.com/Particular/docs.particular.net/master/servicecontrol/servicecontrol-instances/configuration.md) L1064-1092).

#### Wolverine
- **Constants:** [DeadLetterQueueConstants.cs@V6.51.0](https://raw.githubusercontent.com/JasperFx/wolverine/V6.51.0/src/Wolverine/Transports/DeadLetterQueueConstants.cs).
- **Modes:** native, InteropFriendly, enhanced, or WolverineStorage ([rabbitmq/deadletterqueues.md](https://raw.githubusercontent.com/JasperFx/wolverine/V6.51.0/docs/guide/messaging/transports/rabbitmq/deadletterqueues.md)).
- **Envelope keys** are in [EnvelopeConstants.cs](https://raw.githubusercontent.com/JasperFx/wolverine/V6.51.0/src/Wolverine/EnvelopeConstants.cs); the property mapping is in [RabbitMqEnvelopeMapper.cs](https://raw.githubusercontent.com/JasperFx/wolverine/V6.51.0/src/Transports/RabbitMQ/Wolverine.RabbitMQ/Internal/RabbitMqEnvelopeMapper.cs).
- **Idempotency window:** `KeepAfterMessageHandling` is 5 minutes ([DurabilitySettings.cs](https://raw.githubusercontent.com/JasperFx/wolverine/V6.51.0/src/Wolverine/DurabilitySettings.cs) L394).
- **Dead-letter destination:** endpoints expose `DeadLetterStorageMode` (Durable, Native, or NativeWithRecovery) so monitors can see where dead letters go ([dead-letter-storage.md](https://raw.githubusercontent.com/JasperFx/wolverine/V6.51.0/docs/guide/durability/dead-letter-storage.md)).

#### Rebus
- **Headers:** [Headers.cs@8.9.5](https://raw.githubusercontent.com/rebus-org/Rebus/8.9.5/Rebus/Messages/Headers.cs).
- **Writing the details:** [DeadletterQueueErrorHandler.cs](https://raw.githubusercontent.com/rebus-org/Rebus/8.9.5/Rebus/Retry/PoisonQueues/DeadletterQueueErrorHandler.cs) L58-61 writes `"{Message}: {Details}"`. The text is truncated only when `ErrorDetailsHeaderMaxLength` is set; it defaults to `int.MaxValue`.
- **Aggregation:** [DefaultRetryStep.cs](https://raw.githubusercontent.com/rebus-org/Rebus/8.9.5/Rebus/Retry/Simple/DefaultRetryStep.cs) L294-302 aggregates as `"{n} unhandled exceptions"`, with each entry written as `"{Time}: {Exception.ToString()}"`.
- **Defaults:** error queue `error`, 5 attempts ([RetryStrategySettings.cs](https://raw.githubusercontent.com/rebus-org/Rebus/8.9.5/Rebus/Retry/Simple/RetryStrategySettings.cs)).
- **RabbitMQ transport:** `x-delivery-count` is removed before the error-queue copy ([RabbitMqErrorHandlerDecorator.cs@10.1.2](https://raw.githubusercontent.com/rebus-org/Rebus.RabbitMq/10.1.2/Rebus.RabbitMq/Internals/RabbitMqErrorHandlerDecorator.cs)) and mapped to `rbs2-delivery-count` ([RabbitMqTransport.cs](https://raw.githubusercontent.com/rebus-org/Rebus.RabbitMq/10.1.2/Rebus.RabbitMq/RabbitMq/RabbitMqTransport.cs) L715-728).

#### Brighter
- **Headers:** [HeaderNames.cs@10.8.0](https://raw.githubusercontent.com/BrighterCommand/Brighter/10.8.0/src/Paramore.Brighter.MessagingGateway.RMQ.Async/HeaderNames.cs).
- **Reject and invalid channel:** [RmqMessageConsumer.cs](https://raw.githubusercontent.com/BrighterCommand/Brighter/10.8.0/src/Paramore.Brighter.MessagingGateway.RMQ.Async/RmqMessageConsumer.cs) L368-395 and L575-595.
- **Requeue:** publishes first and acks second.
- **Publisher:** [RmqMessagePublisher.cs](https://raw.githubusercontent.com/BrighterCommand/Brighter/10.8.0/src/Paramore.Brighter.MessagingGateway.RMQ.Async/RmqMessagePublisher.cs) shows `HandledCount` and `x-original-message-id`.

#### EasyNetQ and Hosepipe
- **Envelope:** [Error.cs@8.1.11](https://raw.githubusercontent.com/EasyNetQ/EasyNetQ/8.1.11/Source/EasyNetQ/SystemMessages/Error.cs).
- **Publishing the error:** [DefaultConsumeErrorStrategy.cs](https://raw.githubusercontent.com/EasyNetQ/EasyNetQ/8.1.11/Source/EasyNetQ/Consumer/DefaultConsumeErrorStrategy.cs) is persistent and sets `Type = Error`.
- **Names:** [Conventions.cs](https://raw.githubusercontent.com/EasyNetQ/EasyNetQ/8.1.11/Source/EasyNetQ/Conventions.cs) L199-203.
- **Hosepipe retry:** [ErrorRetry.cs](https://raw.githubusercontent.com/EasyNetQ/EasyNetQ/8.1.11/Source/EasyNetQ.Hosepipe/ErrorRetry.cs) publishes to `""` with routing key `error.Queue` and the mandatory flag.
- **Real v9 example** ([wiki](https://github.com/EasyNetQ/EasyNetQ/wiki/Re-Submitting-Error-Messages-With-EasyNetQ.Hosepipe)):
```
{"RoutingKey":"order.placed","Exchange":"orders","Queue":"billing.orders",
 "Exception":"System.InvalidOperationException: ...full stack trace...","Message":"{\"Id\":42}",
 "DateTime":"2026-10-05T15:50:13.4357656Z",
 "BasicProperties":{"DeliveryMode":2,"CorrelationId":"...","Type":"orders.placed.v1","Headers":{}}}
```
- **Default scheduler:** TTL plus DLX ([ServiceCollectionExtensions.cs](https://raw.githubusercontent.com/EasyNetQ/EasyNetQ/8.1.11/Source/EasyNetQ/ServiceCollectionExtensions.cs) L63; [DeadLetterExchangeAndMessageTtlScheduler.cs](https://raw.githubusercontent.com/EasyNetQ/EasyNetQ/8.1.11/Source/EasyNetQ/DeadLetterExchangeAndMessageTtlScheduler.cs)).

### Java

#### Spring AMQP and Spring Cloud Stream
- **Spring AMQP recoverer:**
  - Recoverer code: [RepublishMessageRecoverer.java@v4.1.1](https://raw.githubusercontent.com/spring-projects/spring-amqp/v4.1.1/spring-rabbit/src/main/java/org/springframework/amqp/rabbit/retry/RepublishMessageRecoverer.java) L60-88 and L201-246.
  - The stack-trace default changed ([#3518](https://github.com/spring-projects/spring-amqp/issues/3518)).
  - The reference docs say "The stack trace of the error is not included by default" ([resilience docs](https://raw.githubusercontent.com/spring-projects/spring-amqp/v4.1.1/src/reference/antora/modules/ROOT/pages/amqp/resilience-recovering-from-errors-and-broker-failures.adoc) L160-163).
- **Spring AMQP `retry-count`:** defined in [MessageProperties.java](https://raw.githubusercontent.com/spring-projects/spring-amqp/v4.1.1/spring-amqp/src/main/java/org/springframework/amqp/core/MessageProperties.java) L72-77 and converted in [DefaultMessagePropertiesConverter.java](https://raw.githubusercontent.com/spring-projects/spring-amqp/v4.1.1/spring-rabbit/src/main/java/org/springframework/amqp/rabbit/support/DefaultMessagePropertiesConverter.java).
- **Spring Cloud Stream binder:**
  - Binder code: [RabbitMessageChannelBinder.java@v5.0.3](https://raw.githubusercontent.com/spring-cloud/spring-cloud-stream/v5.0.3/binders/rabbit-binder/spring-cloud-stream-binder-rabbit/src/main/java/org/springframework/cloud/stream/binder/rabbit/RabbitMessageChannelBinder.java) L733-830.
  - DLQ docs: [rabbit_dlq.adoc](https://raw.githubusercontent.com/spring-cloud/spring-cloud-stream/v5.0.3/docs/modules/ROOT/pages/rabbit/rabbit_dlq.adoc).
- **Illustrative headers:**
```
x-exception-message: Order 42 was not found
x-exception-stacktrace: org.springframework...ListenerExecutionFailedException: ... Caused by: java.lang.IllegalStateException: Order 42 was not found
	at com.acme.OrderListener.handle(OrderListener.java:31) ...
x-original-exchange: orders        x-original-routingKey: order.placed        retry-count: 3 (long)
__TypeId__: com.acme.OrderPlaced   content_type: application/json
```
- **Fingerprinting:** take the **deepest `Caused by:`** class plus its first application frame. When the stack trace is absent (Spring AMQP 4.0.5 and later), only the message text is left.

### Python

#### Celery, kombu and Flower
- **Protocol:**
  - Protocol v2 is documented in [protocol.rst@v5.6.3](https://raw.githubusercontent.com/celery/celery/v5.6.3/docs/internals/protocol.rst).
  - The header list is built in [amqp.py](https://raw.githubusercontent.com/celery/celery/v5.6.3/celery/app/amqp.py) L366-384 (note `timelimit` is `[time_limit, soft_time_limit]`).
- **Expired tasks are revoked** ([request.py](https://raw.githubusercontent.com/celery/celery/v5.6.3/celery/worker/request.py) L408-506).
- **Native delayed delivery:**
  - Uses `celery_delayed_{0..27}` and `celery_delayed_delivery`.
  - The routing key is `'.'.join(f'{countdown:028b}') + '.' + routing_key` ([native_delayed_delivery.py@v5.6.2](https://raw.githubusercontent.com/celery/kombu/v5.6.2/kombu/transport/native_delayed_delivery.py)).
  - Present since kombu v5.5.0.
- **Quorum queues:** supported since 5.5 ([rabbitmq.rst](https://raw.githubusercontent.com/celery/celery/v5.6.3/docs/getting-started/backends-and-brokers/rabbitmq.rst) L176-215).
- **Flower:** the API has apply, async-apply, send-task, result, abort, queue lengths and task listing ([tasks.py](https://raw.githubusercontent.com/mher/flower/master/flower/api/tasks.py)). It has no dead-letter replay.

#### Dramatiq
- **Queues:** declared with DLX `""` and routing key `{q}.XQ`. `{q}.XQ` has `x-message-ttl` = `DEAD_MESSAGE_TTL`, 7 days by default and overridable with `dramatiq_dead_message_ttl` ([rabbitmq.py@v2.2.1](https://raw.githubusercontent.com/Bogdanp/dramatiq/v2.2.1/dramatiq/brokers/rabbitmq.py) L39 and L326-354).
- **Names:** [common.py](https://raw.githubusercontent.com/Bogdanp/dramatiq/v2.2.1/dramatiq/common.py) L150-174.
- **Retries:** [retries.py](https://raw.githubusercontent.com/Bogdanp/dramatiq/v2.2.1/dramatiq/middleware/retries.py) L105-124.
- **Delays:** workers hold `{q}.DQ` messages in memory until their eta ([worker.py](https://raw.githubusercontent.com/Bogdanp/dramatiq/v2.2.1/dramatiq/worker.py) L347-351).
- **Illustrative body:**
```
{"queue_name":"default","actor_name":"send_email","args":[42],"kwargs":{},
 "options":{"retries":20,"traceback":"Traceback (most recent call last):\n ...\nValueError: boom\n","requeue_timestamp":1792150000000},
 "message_id":"...","message_timestamp":1792140000000}
```

#### FastStream
- **Ack policy:** `REJECT_ON_ERROR` is the RabbitMQ default ([rabbit/subscriber/config.py@0.7.7](https://raw.githubusercontent.com/ag2ai/faststream/0.7.7/faststream/rabbit/subscriber/config.py) L40-46).
- **Generated ids:** `message_id` and `correlation_id` ([parser.py](https://raw.githubusercontent.com/ag2ai/faststream/0.7.7/faststream/rabbit/parser.py)).

### PHP

#### Symfony Messenger
- **Delay queues:** [Connection.php@v8.1.9](https://raw.githubusercontent.com/symfony/symfony/v8.1.9/src/Symfony/Component/Messenger/Bridge/Amqp/Transport/Connection.php) L116-120 and L415-452.
- **Serialization:**
  - [PhpSerializer.php](https://raw.githubusercontent.com/symfony/symfony/v8.1.9/src/Symfony/Component/Messenger/Transport/Serialization/PhpSerializer.php) L201-214 uses `addslashes(serialize())` and falls back to Base64.
  - [Serializer.php](https://raw.githubusercontent.com/symfony/symfony/v8.1.9/src/Symfony/Component/Messenger/Transport/Serialization/Serializer.php) L47 uses `STAMP_HEADER_PREFIX = 'X-Message-Stamp-'`.
- **Stamps:** [ErrorDetailsStamp.php](https://raw.githubusercontent.com/symfony/symfony/v8.1.9/src/Symfony/Component/Messenger/Stamp/ErrorDetailsStamp.php), [RedeliveryStamp.php](https://raw.githubusercontent.com/symfony/symfony/v8.1.9/src/Symfony/Component/Messenger/Stamp/RedeliveryStamp.php).
- **Parsing:** a TypeScript decoder needs a **safe** PHP-unserialize tokenizer that never instantiates objects.

#### Laravel
- **Queue code:** [RabbitMQQueue.php@v15.0.2](https://raw.githubusercontent.com/vyuldashev/laravel-queue-rabbitmq/v15.0.2/src/Queue/RabbitMQQueue.php):
  - L546-590: `content_type` `application/json`, and the `laravel` table holding `{attempts}`;
  - L655-668: delay queue arguments;
  - L699-711: the failed exchange and routing key.
- **Defaults:** [QueueConfig.php](https://raw.githubusercontent.com/vyuldashev/laravel-queue-rabbitmq/v15.0.2/src/Queue/QueueConfig.php) L25-29 sets `failedRoutingKey='%s.failed'`.
- **Failure:** a failed job is rejected without requeue ([RabbitMQJob.php](https://raw.githubusercontent.com/vyuldashev/laravel-queue-rabbitmq/v15.0.2/src/Queue/Jobs/RabbitMQJob.php) L87-94).
- **Payload keys:** [Queue.php@v13.37.0](https://raw.githubusercontent.com/laravel/framework/v13.37.0/src/Illuminate/Queue/Queue.php) L179-195.
- **Laravel's own retry:** `queue:retry` resets attempts and refreshes `retryUntil` ([RetryCommand.php](https://raw.githubusercontent.com/laravel/framework/v13.37.0/src/Illuminate/Queue/Console/RetryCommand.php) L160-208).

### Node

#### NestJS and amqp-connection-manager
- **Defaults:** `RMQ_DEFAULT_NOACK = true` and `RMQ_DEFAULT_PERSISTENT = false` ([constants.ts@v12.1.3](https://raw.githubusercontent.com/nestjs/nest/v12.1.3/packages/microservices/constants.ts) L21-22).
- **Unknown patterns** are nacked without requeue ([server-rmq.ts](https://raw.githubusercontent.com/nestjs/nest/v12.1.3/packages/microservices/server/server-rmq.ts) L336-378).
- **Underlying libraries:** NestJS uses amqp-connection-manager and amqplib.

#### @golevelup/nestjs-rabbitmq
- **Default:** `defaultSubscribeErrorBehavior: REQUEUE` ([connection.ts](https://raw.githubusercontent.com/golevelup/nestjs/master/packages/rabbitmq/src/amqp/connection.ts) L109; [errorBehaviors.ts](https://raw.githubusercontent.com/golevelup/nestjs/master/packages/rabbitmq/src/amqp/errorBehaviors.ts)).
- **Detection signal:** in the DLQ centre, a `delivery_limit` death reason paired with this library means a poison loop.

#### Moleculer Channels
- **Header names:** [constants.js@v0.3.1](https://raw.githubusercontent.com/moleculerjs/moleculer-channels/v0.3.1/src/constants.js).
- **Move to dead letter:** [amqp.js](https://raw.githubusercontent.com/moleculerjs/moleculer-channels/v0.3.1/src/adapters/amqp.js) L460-495. A new header set replaces the original headers.
- **Error headers:** the stack and data are Base64 ([utils.js](https://raw.githubusercontent.com/moleculerjs/moleculer-channels/v0.3.1/src/utils.js) L66-90).
- **Defaults:** `FAILED_MESSAGES` and `maxRetries: 3` ([base.js](https://raw.githubusercontent.com/moleculerjs/moleculer-channels/v0.3.1/src/adapters/base.js) L46-51).

### Go

#### Watermill
- **Poison keys:** [poison.go@v1.5.3](https://raw.githubusercontent.com/ThreeDotsLabs/watermill/v1.5.3/message/router/middleware/poison.go) L14-18. Note `topic_poisoned`, not `poisoned_topic`.
- **Requeuer:** [requeuer.go](https://raw.githubusercontent.com/ThreeDotsLabs/watermill/v1.5.3/components/requeuer/requeuer.go) L14 and L137-145.
- **Delay:** [delay.go](https://raw.githubusercontent.com/ThreeDotsLabs/watermill/v1.5.3/components/delay/delay.go) L56-67.
- **Message UUID header:** [marshaler.go@v3.1.0](https://raw.githubusercontent.com/ThreeDotsLabs/watermill-amqp/v3.1.0/pkg/amqp/marshaler.go) L9.

### Ruby

#### Sneakers, Kicks and Hutch
- **Kicks Maxretry:** [maxretry.rb@3.4.0](https://raw.githubusercontent.com/ruby-amqp/kicks/3.4.0/lib/sneakers/handlers/maxretry.rb):
  - L46-86: the topology;
  - L132-180: the `retry_info` header;
  - L183-202: `failure_count` read from `x-death`.
- **Older Sneakers format:** Sneakers v2.11.0 sent a Base64 body ([maxretry.rb@v2.11.0](https://raw.githubusercontent.com/jondot/sneakers/v2.11.0/lib/sneakers/handlers/maxretry.rb)).
- **Hutch:** [nack_on_all_failures.rb@v2.0.0](https://raw.githubusercontent.com/ruby-amqp/hutch/v2.0.0/lib/hutch/acknowledgements/nack_on_all_failures.rb) calls `nack(tag, false, false)`.
- **Bunny:** already exposes the 4.3 `x-delayed-retry-*` constants ([queue.rb](https://raw.githubusercontent.com/ruby-amqp/bunny/main/lib/bunny/queue.rb) L34-36).

---

## 5. MassTransit v9 commercial licence: facts and impact

**Announcement and timeline.** [v9-announcement.md@v8.5.0](https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.0/doc/content/1.introduction/v9-announcement.md); the Q&A was updated on 2025-04-03.

| Milestone | Date |
| --- | --- |
| v9 prereleases | Q3 2025 |
| v9 general availability (target) | Q1 2026 |
| v9 general availability (actual) | 9.0.0 on 2026-01-06 ([catalog](https://api.nuget.org/v3/catalog0/data/2026.01.06.20.13.15/masstransit.9.0.0.json)) |
| v8 patches promised | "through at least the end of 2026" |
| v8 end of official maintenance | "After 2026" |

**Price targets announced in 2025:**
- USD 400 a month or 4,000 a year for small and medium businesses;
- USD 1,200 a month or 12,000 a year for large organisations.
- Current list prices are rendered client-side on massient.com and were not verified.

**Licence terms** ([massient.com/license](https://massient.com/license), last updated 2026-09-17):
- A subscription that keeps perpetual rights to the last licensed version.
- Two scopes:
  - Single-Product Line;
  - Organization-Wide.
- Not priced by messages, endpoints or deployments.
- v8 and earlier "remain free and open source... However, they are unsupported under this Agreement."
- FAQ ([massient.com](https://massient.com/)):
  - organisations under USD 1M in revenue may get a 100% discount, without commercial support;
  - so may non-profits under USD 1M in expenses;
  - v9 is "source-available", not permissively licensed.
- A licence key is required, through `MT_LICENSE` or `MT_LICENSE_PATH` ([license docs](https://masstransit.massient.com/configuration/license/)).

**State of each line:**
- The public GitHub repo is still the Apache-2.0 v8 line; its `develop` README says "Apache 2.0 licensed", and the tags stop at v8.5.10.
- NuGet already ships 8.5.11 (2026-09-30), and the latest v9 is 9.2.3 (2026-10-02).

**Adoption split.** MassTransit.RabbitMQ downloads per version, for releases published since v9 GA:

| Versions | Downloads |
| --- | --- |
| 8.5.8 to 8.5.10 | about 6.18M |
| All 9.x | about 1.33M |

That is about 4.6 to 1 in favour of v8. Counts for the newest versions are not yet populated.

**Impact on the product:**
1. **Decoders:** the same header and queue conventions hold across v8 and v9, so the decoders are shared. Generate fixtures from v8 under Apache-2.0. Never copy v9 code, which is source-available and restricts derivative works.
2. **Demand after v8 maintenance ends:** v8 users after 2026 will want free tooling that is maintained independently. That supports a strong MassTransit decoder in v1.
3. **Infrastructure recognition:** v9 brings new infrastructure to recognise, namely `mt-delay-*` and `MT-Original-RoutingKey`. It also recommends the CloudAMQP plugin fork.
4. **Competition:** the v9 Dashboard (fault inbox and requeue, commercial, early access) and Particular's free early-access ServicePulse for MassTransit compete in the .NET niche. Both are tied to a single framework.
5. **Migration:** some users will move to Wolverine, Rebus, Brighter or NServiceBus. That raises the priority of those decoders.

---

## 6. Recognising retry and delay infrastructure, so it is not counted as failure

| Pattern | Framework | Meaning | Hint for the UI |
| --- | --- | --- | --- |
| `nsb.v2.delay-level-00`..`27`, exchange `nsb.v2.delay-delivery`, policy `nsb.{q}.delivery-limit` | NServiceBus | Delayed retries or scheduled sends; `x-death` reason expired | Decode the 28-bit routing key to show the due time |
| `celery_delayed_0`..`27`, `celery_delayed_delivery` | Celery 5.5+ | ETA or countdown on quorum queues | Same bit decoding |
| `mt-delay-{ms}`, `mt-delay-return` (custom prefix possible) | MassTransit 9.1+ | Queue-based redelivery | Show `MT-Redelivery-Count` |
| `{exchange}_delay` exchange of type `x-delayed-message` | MassTransit v8 | Plugin-based redelivery or scheduling | Flag as a 4.3 upgrade blocker |
| `delays` exchange plus `delay_{ex}_{rk}_{ms}_retry`, `_delay`, optional `_YYYY-MM-DD` | Symfony | Retry or DelayStamp; queues auto-expire | Show `RedeliveryStamp.retryCount` |
| `{q}.delay.{ms}` | Laravel | `release()` or `later()` | Show `laravel.attempts` |
| `{q}-retry`, `{q}-retry-requeue`, `{q}-error` | Sneakers/Kicks | TTL retry loop | Count from `x-death` |
| `{q}.DQ`, `{q}.XQ` | Dramatiq | Worker-held delays; dead letters with a 7-day TTL | Warn that dead letters expire |
| `{exchange}_{dd_hh_mm_ss}` | EasyNetQ | Future publish | Not applicable |
| `{q}_skipped` | MassTransit | No consumer; not a code failure | Group separately |
| `Particular.ServiceControl*`, `error`, `error.log`, `*_return.poison` | Particular | Managed by ServiceControl | Read-only, and warn |
| `wolverine-dead-letter-queue` | Wolverine | System dead-letter queue | Not applicable |
| `{destination}.{group}.dlq`, `{queue}.parkingLot` | Spring Cloud Stream | DLQ and parking lot | Not applicable |

---

## 7. Priority of built-in decoders for v1

| Rank | Decoder | Why | Effort |
| --- | --- | --- | --- |
| 0 | Generic broker layer | Covers the rest. See below. | M |
| 1 | MassTransit v8 and v9 | Largest .NET RabbitMQ stack (147M downloads); richest headers; v8 is unmaintained after 2026; already decoded by Warren, ServicePulse and the MT Dashboard, so it is table stakes. | M |
| 2 | Spring AMQP and Spring Cloud Stream | Dominant JVM stack; x-exception headers; Warren covers it. | M |
| 3 | NServiceBus | Rich, documented headers; exact replay rules (ServiceControl); delay infrastructure and policy. Detect ServiceControl and step aside. | S to M |
| 4 | EasyNetQ (v8 and v9) | 47.8M downloads; the body must be unwrapped to show the real message; replay compatible with Hosepipe. | S |
| 5 | Celery | Largest Python base. Gives identity and correct replay (expires, retries, ETA infrastructure), but no exception data. | M |
| 6 | Symfony Messenger | Large PHP base; exception class, message and trace from stamps. | L |
| 7 | Rebus | 17.4M downloads; headers only. | S |
| 8 | Wolverine | Growing, and a destination for MassTransit migrations; headers only. | S |
| 9 | Laravel (vyuldashev) | 370k a month; payload plus the nested `laravel` table. | S to M |
| 10 | Dramatiq | Dead letters expire after 7 days; traceback in the body. | S |
| 11 | Sneakers/Kicks | `retry_info`, plus the legacy Base64 body. | S |
| 12+ | Plugin SDK and community | Brighter, Moleculer Channels, Watermill, NestJS/golevelup (pattern only), FastStream, Hutch, DotNetCore.CAP. | S each |

- **Rank 0 (generic broker layer)** covers:
  - x-death, x-opt-deaths, first and last death headers;
  - delivery and acquired counts;
  - death reasons;
  - TTL;
  - the infrastructure recognisers in section 6;
  - AMQP-property identity.

  It is enough on its own for Celery, FastStream, NestJS, Hutch, Brighter, Wolverine in native mode, and Laravel.
- **Rank 5 (Celery):** decode JSON, msgpack and YAML. Disassemble pickle only, never execute it.
- **Rank 6 (Symfony Messenger):** needs both the X-Message-Stamp JSON headers and a safe PHP-unserialize parser.

**Releases:**
- v1.0 covers ranks 0 to 5.
- v1.1 covers ranks 6 to 11.
- The rest ship through a public decoder SDK.

**Detection signals**, in order:

| Order | Signal | Points to |
| --- | --- | --- |
| 1 | Content type `application/vnd.masstransit+*` | MassTransit |
| 2 | AMQP `type` beginning `EasyNetQ.SystemMessages.Error` | EasyNetQ |
| 3 | Header prefixes or names: `MT-`, `NServiceBus.`, `rbs2-`, `x-exception-`, `exception-type` | MassTransit, NServiceBus, Rebus, Spring, Wolverine |
| 3 (cont.) | `x-error-`, `retry_info`, `X-Message-Stamp-`, `laravel` | Moleculer, Sneakers/Kicks, Symfony, Laravel |
| 3 (cont.) | `task` with `lang`, `_watermill_message_uuid`, `cloudEvents_` with `HandledCount`, `cap-msg-id` | Celery, Watermill, Brighter, DotNetCore.CAP |
| 4 | Body shapes: Dramatiq `{actor_name, options}`, NestJS `{pattern, data}`, Laravel `{uuid, displayName, job}`, Sneakers 2.11 or earlier `{payload(base64)}` | Dramatiq, NestJS, Laravel, Sneakers |
| 5 | Queue-name suffixes (sections 3 and 6) | Several |
| 6 | Connection `client_properties` of consumers: NServiceBus sets `client_api=NServiceBus`, `endpoint_name`, `nservicebus_version` ([ConnectionFactory.cs](https://raw.githubusercontent.com/Particular/NServiceBus.RabbitMQ/11.2.1/src/NServiceBus.Transport.RabbitMQ/Connection/ConnectionFactory.cs) L93-116); MassTransit names its connection after the process | Works even when the DLQ is empty |

---

## 8. Normalised failure model and fingerprinting

**Model fields:**
- `framework` and `frameworkVersionHint`;
- `exceptionType` (the root cause, where known) and `innerTypes[]`;
- `exceptionMessage` and `stackTrace` (raw and parsed frames);
- `failedAt`;
- `attempts`, holding framework-specific counters;
- `deathHistory`, the parsed `x-death`;
- `deliveryCount`;
- `originalQueue`, `originalExchange`, `originalRoutingKey`, each with a confidence and its source;
- `logicalMessageId`, `messageType` (or task or actor), `consumer` (or handler), `host`;
- `correlationId` and `conversationId`;
- `contentType` and codec;
- `raw`.

**Fingerprint algorithm.** The baseline is ServiceControl's "type + first frame" ([classifier](https://raw.githubusercontent.com/Particular/ServiceControl/6.21.2/src/ServiceControl/Recoverability/Grouping/Groupers/ExceptionTypeAndStackTraceFailureClassifier.cs)). Improvements:

1. **Choose the root cause:**
   - MassTransit already reports the base exception.
   - Java: the last `Caused by:`.
   - .NET `ToString()`: the innermost ` ---> ` entry.
   - Python: the last line of the traceback.
   - Rebus: parse each aggregated block.
2. **Parse frames with a parser per language** (.NET, Java, Python, PHP's FlattenException or `#n` lines, Ruby, Node). Drop file paths, line numbers, compiler-generated async or lambda names, and CGLIB or proxy suffixes.
3. **Pick the first application frame,** skipping framework namespaces such as `MassTransit.`, `NServiceBus.`, `Rebus.`, `System.`, `Microsoft.`, `org.springframework.`, `java.`, `jdk.`, `celery/`, `kombu/`, `Symfony\` and `Illuminate\`. Fall back to the first frame.
4. **Normalise the message into a template:** replace GUIDs, numbers, hex strings, quoted literals, e-mail addresses, IP addresses, URLs and timestamps with tokens, then cap the length at 200 characters.
5. **Compute the key:** `fp = sha1(framework | rootType | appFrame | [template])`. Offer several granularities, as ServicePulse does: type only; type plus frame; type plus frame plus template.
6. **When there is no exception data** (Celery, FastStream, NestJS, Hutch, Laravel, native-DLX modes): `fp = sha1(framework | messageType or task or pattern | x-death[0].reason | x-death[0].queue)`.
7. **Secondary group-by options:** message type, original queue, consumer, host, death reason, and first-failure time bucket.

---

## 9. Replay and redrive design

### 9.1 Resolving the destination, from first choice to last

1. **The framework's explicit field:**
   - MassTransit: the last segment of `MT-Fault-InputAddress`;
   - NServiceBus: `ServiceControl.RetryTo`, then `TargetEndpointAddress`, then `NServiceBus.FailedQ`;
   - Rebus: `rbs2-source-queue`;
   - EasyNetQ: `Error.Queue`;
   - Wolverine: `original-destination`;
   - Moleculer: `x-original-group` and `x-original-channel`;
   - Watermill: `topic_poisoned`;
   - Sneakers: the worker queue;
   - Dramatiq: the body's `queue_name`.
2. **The newest `x-death` entry whose reason is `rejected` or `delivery_limit`:** use its `queue`. Skip `expired` entries from known delay queues.
3. **A naming convention:** strip `_error`, `.dlq`, `.XQ`, `.failed` or `-error`.
4. **For Spring:** `x-original-exchange` plus `x-original-routingKey`. This is shown only with a **fan-out warning**, because it reaches every bound queue and other consumer groups will get duplicates.
5. **A mapping from the user**, saved per vhost (for example Symfony `originalReceiverName` to exchange).

**Rules for publishing:**
- By default, publish **to the queue** through the default exchange (`""`, with the routing key set to the queue).
- Replaying through the original exchange is an explicit choice for pub/sub replay.
- Check that the target exists (passive declare or the management API) and whether it has consumers.
- Publish with `mandatory`. Treat `basic.return` as a failure.

### 9.2 Header policy

The default is to **strip markers, reset counters, preserve identity, and add provenance.** Users can switch counters to "continue".

**Every framework**
- **Strip:**
  - `x-death`, `x-first-death-*`, `x-last-death-*`;
  - `x-delivery-count`, `x-acquired-count`;
  - optionally `x-shovelled*` and `x-received-from`;
  - `expiration` (clear it or recompute it);
  - `user_id`, unless it matches the replay user.
- **Counters (default reset):** none.
- **Preserve:**
  - `message_id`, `correlation_id`, `type`;
  - `content_type`, `content_encoding`;
  - `timestamp`, `app_id`, `priority`, `delivery_mode`=2;
  - the body, byte-for-byte.

**MassTransit**
- **Strip:** `MT-Reason`, `MT-Fault-*`.
- **Counters:** `MT-Redelivery-Count`.
- **Preserve:**
  - the envelope `messageId`;
  - `MT-Host-*` is harmless and can stay.

**NServiceBus**
- **Strip:**
  - `NServiceBus.FailedQ`;
  - `NServiceBus.TimeOfFailure`;
  - `NServiceBus.ExceptionInfo.*`;
  - `ServiceControl.EditOf`.
- **Counters:** `NServiceBus.Retries*`.
- **Preserve:** `NServiceBus.MessageId`. An edited copy gets a new id plus a link header.

**Wolverine**
- **Strip:** `exception-*`, `failed-at`, `original-destination`.
- **Counters:** `attempts` (to be verified).
- **Preserve:** `id` / `message_id`.

**Rebus**
- **Strip:** `rbs2-error-details`, `rbs2-source-queue`.
- **Counters:** `rbs2-delivery-count`.
- **Preserve:** `rbs2-msg-id`.

**Brighter**
- **Strip:** `RejectionReason/-Message/-Timestamp`, `OriginalTopic/-Type` (invalid-message channel only).
- **Counters:** `HandledCount`.
- **Preserve:** `MessageId`, `x-original-message-id`, `cloudEvents_id`.

**EasyNetQ**
- **Strip:** none, because the body is unwrapped instead.
- **Counters:** none.
- **Preserve:** `BasicProperties` from the envelope. Check that header values have not become Base64 strings.

**Spring and Spring Cloud Stream**
- **Strip:** `x-exception-message`, `x-exception-stacktrace`; optionally `x-original-*`.
- **Counters:** `retry-count`.
- **Preserve:** `__TypeId__` and other type headers.

**Celery**
- **Strip:** nothing; refresh or clear `expires`.
- **Counters:** `retries`.
- **Preserve:** `id`, `root_id`, `parent_id`, `task`.

**Dramatiq**
- **Strip:** `options.traceback` (a body edit).
- **Counters:** `options.retries` (a body edit).
- **Preserve:** `message_id`.

**Symfony with the Serializer format**
- **Strip:** the `X-Message-Stamp-` headers for RedeliveryStamp, ErrorDetailsStamp and SentToFailureTransportStamp.
- **Counters:** RedeliveryStamp.
- **Preserve:** `type`. With PhpSerializer, the body is opaque, so replay it as-is.

**Laravel**
- **Strip:** none.
- **Counters:** `laravel.attempts` to 0. Warn about `retryUntil`.
- **Preserve:** payload `uuid` and `id`.

**Moleculer**
- **Strip:** `x-error-*`, `x-original-*`.
- **Counters:** `x-redelivered-count`.
- **Preserve:** none.

**Watermill**
- **Strip:** the `*_poisoned` headers.
- **Counters:** `_watermill_requeuer_retries`.
- **Preserve:** `_watermill_message_uuid`.

**Sneakers/Kicks**
- **Strip:** `retry_info`; restore the original headers from it. Strip `x-death` so that Maxretry sees a fresh count.
- **Counters:** none.
- **Preserve:** the original properties.

**Provenance headers to add** (names to finalise; RabbitMQ advises "a separate x- header" that the broker will not update):
- `x-<tool>-replay-id` (a ULID);
- `x-<tool>-replay-count` (incremented);
- `x-<tool>-replayed-from` (the DLQ);
- `x-<tool>-replayed-at`;
- `x-<tool>-replayed-by` (a team-server principal);
- an optional, size-capped `x-<tool>-original-death`.

Make them optional, because frameworks may copy inbound headers onto outgoing messages (MassTransit's `TransferConsumeContextHeaders` copies non-`MT-` headers when forwarding or redelivering).

### 9.3 Idempotency

- **Preserve the logical message id by default.**
  - MassTransit's inbox, the NServiceBus outbox and Wolverine's durable inbox all deduplicate on it.
  - Celery and Dramatiq do not deduplicate, but the id ties retries together. A revoked Celery task id is dropped.
- **For edited messages,** follow the ServiceControl pattern: a new id plus a link header. Otherwise, an outbox that has seen the id discards the edit.
- **Keep a replay journal** in the team server's database, keyed by job, logical id (or a hash of the body plus key headers) and target. It prevents a message being replayed twice within a job, or concurrently from two operators.

### 9.4 Safe mechanics

1. **Ordering:** consume the DLQ with manual ack and a bounded prefetch, publish with confirms and the mandatory flag, and **ack the source only after the confirm.** Brighter and Spring Cloud Stream use the same order, and ServiceControl adds a staging queue.
2. **Group retries:** optionally move the selection to a staging queue first, then forward it with throttling. This allows cancelling, and it survives a client disconnect. Run the job on the team server or as a shovel (moving) job.
3. **Throttling and canaries:** use a token-bucket throttle and send a canary of the first N messages. After the replay, watch the error queue for the same logical ids, and pause when the re-failure rate passes a threshold. ServiceControl uses `ServiceControl.Retry.AcknowledgementQueue` for the same purpose.
4. **"Undo" means re-parking:** re-publish the journaled copy to the DLQ or a parking queue. Present it honestly: a message that has already been consumed cannot be un-consumed.
5. **Scheduled replay:** on 4.4+ quorum-queue targets, use `x-opt-delivery-time`. Otherwise, schedule it on the team server. Never rely on the archived plugin.

### 9.5 Hazards that depend on the RabbitMQ version

- **Quorum-queue DLQs with a finite delivery limit** (the default is 20 since 4.0) can drop dead letters when inspected. Detect this before peeking. Offer a `delivery-limit: -1` policy, or recommend classic or stream DLQs. On 4.3, never peek with `basic.reject` or by closing the channel while holding deliveries.
- **On 4.3 queues with `delayed-retry-type` set to `all` or `returned`,** a nack-based peek hides the messages for at least `delayed-retry-min`.
- **NServiceBus** creates `nsb.{q}.delivery-limit` policies. The policy debugger must show them, and our tool must not override them.
- **Messages that expire:**
  - Dramatiq `.XQ` loses its dead letters after 7 days;
  - Celery honours `expires`;
  - Laravel honours `retryUntil`;
  - per-message `expiration` applies too.
- **The CloudAMQP plugin fork** does not migrate messages that the original plugin delayed. Show this in the 4.3 upgrade advisor.

---

## 10. Existing tools for failed messages

| Tool | Frameworks | Model | Notes |
| --- | --- | --- | --- |
| ServicePulse / ServiceControl 6.21 | NServiceBus; MassTransit through the connector (RabbitMQ and ASB, free early access) | Commercial; code under RPL-1.5 | Ingests and drains queues; grouping; group retry with staging; edit and retry; redirects; audit log |
| MassTransit v9 Dashboard (early access, 9.2.0) | MassTransit v9 only | Commercial | Fault inbox; requeue a group, a message or in bulk; reads through the management API |
| Warren ([warrenops.io](https://warrenops.io)) | Spring and MassTransit | Closed source, self-hosted | Replay rules, edit before replay, parking, masking |
| Rebus Fleet Manager | Rebus | Commercial (Rebus Pro) | Stores failures in place of a DLQ |
| Wolverine CLI and CritterWatch | Wolverine (database dead letters) | OSS CLI; CritterWatch commercial | Native DLQs need broker tooling |
| EasyNetQ Hosepipe | EasyNetQ | OSS CLI | dump, err, retry; warns about quorum-queue limits |
| Flower | Celery | OSS | Task monitoring; no DLQ replay |
| Symfony and Laravel CLIs | Symfony, Laravel | OSS | Work from the failure transport or the `failed_jobs` table |
| dramatiq_dashboard, Laravel Horizon | Dramatiq, Laravel | OSS | **Redis only** |

**Gap:** no open-source tool decodes and redrives failures across more than two of these frameworks on RabbitMQ.

## Design implications

- **Read all dead-letter queues through AMQP 0-9-1 (amqplib) and keep the typed header tables so they round-trip unchanged.** AMQP 1.0 conversion drops non-x- table and array headers (Laravel 'laravel', Celery timelimit and stamps), and it moves x-* headers into message annotations.
- **Ship a decoder plugin SDK in TypeScript.** Each decoder implements detect(msg) returning a confidence, decode(msg) returning a NormalizedFailure, fingerprint(nf), and replayPlan(nf, options) returning target, headersToStrip, headersToSet and an optional body transform. Publish a machine-readable, open-source 'framework failure header registry' (JSON plus docs) as a community asset.
- **Build v1.0 decoders:** the generic broker layer, MassTransit v8/v9, Spring AMQP plus Spring Cloud Stream, NServiceBus, EasyNetQ (v8/v9) and Celery. v1.1 adds Symfony, Rebus, Wolverine, Laravel, Dramatiq and Sneakers/Kicks. Others go through the SDK.
- **Fingerprint failures in layers:** root-cause exception type, first application frame (parser per language, framework frames skipped), and a normalised message template. Offer type-only, type+frame and type+frame+template grouping, following ServiceControl's 'type + first frame' baseline. Without exception data, fall back to framework + message type, task or pattern + x-death[0].reason and queue.
- **Ship infrastructure recognisers** for NServiceBus nsb.v2.delay-level-*, Celery celery_delayed_*, MassTransit v9 mt-delay-*, MassTransit v8 {exchange}_delay, Symfony delay_*, Laravel {q}.delay.{ms}, Sneakers {q}-retry, Dramatiq {q}.DQ/.XQ, EasyNetQ {exchange}_dd_hh_mm_ss, and the Particular.ServiceControl* queues. Expired deaths from these must not count as failures. Decode the 28-bit delay routing keys (NServiceBus and Celery) to show each message's due time.
- **Resolve the replay destination queue-first** and publish through the default exchange: framework field, then the newest rejected or delivery_limit x-death entry, then the naming convention. Use original exchange plus routing key only behind an explicit fan-out warning. Never route by x-first-death-queue alone, because it can point at a delay queue.
- **Strip broker-managed headers on every replay:** x-death, x-first/last-death-*, x-delivery-count and x-acquired-count; also user_id unless it matches the replaying user, and an elapsed expiration. Then apply the per-framework stripping of failure markers.
- **Default to a fresh retry budget**, with an explicit 'continue counters' option. Reset MT-Redelivery-Count, NServiceBus.Retries, retry-count, Celery retries, Dramatiq options.retries, laravel.attempts, Brighter HandledCount, x-redelivered-count and _watermill_requeuer_retries. Edits to body-embedded counters are labelled as message edits in the audit log.
- **Preserve logical message ids** (MassTransit messageId, NServiceBus.MessageId, rbs2-msg-id, Wolverine id, Celery id, Dramatiq message_id) so inboxes and outboxes deduplicate correctly. For edited messages, follow ServiceControl: assign a new id and add a link header back to the failed id.
- **Make the replay engine a durable team-server job:**
  - consume with manual ack;
  - publish with confirms and the mandatory flag, and treat basic.return as failure;
  - ack the source only after the confirm;
  - throttle with a token bucket and run a canary first;
  - offer an optional staging queue for group replays;
  - pause automatically when replayed ids reappear in the error queue;
  - keep a journal for de-duplication, audit and 're-park' (honest undo).
- **Add namespaced provenance headers:** x-<tool>-replay-id, replay-count, replayed-from, replayed-at and replayed-by, plus an optional capped original-death copy. Allow them to be switched off, because some frameworks propagate inbound headers downstream.
- **Detect queues that another system manages and default to read-only:** ServiceControl consumers on 'error', the Particular MassTransit connector, Wolverine DLQ recovery, and consumers on DLQs in general. Detect through /api/consumers and connection client_properties; NServiceBus sets client_api=NServiceBus and endpoint_name, and MassTransit names its connection after the process.
- **Warn before peeking risky quorum-queue DLQs:**
  - a quorum-queue DLQ with a finite delivery limit (default 20 since 4.0);
  - a 4.3 delayed-retry policy of all or returned.
  Offer a one-click delivery-limit -1 policy for the DLQ, or recommend a classic or stream DLQ. Never peek with basic.reject or by closing a channel that holds deliveries.
- **Surface expiry hazards in the UI:** Dramatiq .XQ dead letters expire after 7 days; Celery 'expires'; Laravel retryUntil; per-message expiration. Offer to refresh or clear them at replay time.
- **Add a 4.3 upgrade check for the delayed-message plugin:**
  - detect x-delayed-message exchanges and plugin-dependent frameworks (MassTransit v8 UseDelayedRedelivery, Rebus, Brighter, EasyNetQ DelayedExchangeScheduler, Spring x-delay);
  - present the options: the CloudAMQP fork for 4.3.3+ (no migration of messages already delayed), MassTransit v9 queue-based redelivery, QQ delayed retry on 4.3, x-opt-delivery-time on 4.4, or TTL+DLX tiers.
- **Schedule replays with x-opt-delivery-time** when the target is a 4.4+ quorum queue, otherwise on the team server. Never depend on the archived plugin.
- **Keep licences clean:** implement decoders from observed wire formats and Apache-2.0 sources (MassTransit v8, Spring, Celery and others). Do not copy MassTransit v9 code (source-available) or Particular code (RPL-1.5). Generate test fixtures by running real frameworks in CI (v8 for MassTransit; v9 only with a licence).
- **Deserialize safely:** never execute pickle or PHP unserialize. Use safe tokenisers for PHP-serialized Symfony and Laravel bodies and show pickle only as an opcode disassembly. Show encrypted payloads (MassTransit +aes, Laravel ShouldBeEncrypted) as opaque, with their metadata.
- **Mask PII in failure headers too.** Exception messages and stack traces in headers or bodies (x-exception-message, NServiceBus.ExceptionInfo.Message, Error.Exception, rbs2-error-details) can contain secrets. Lazy-load large stack-trace headers, which can approach frame_max (Spring) or be unbounded (Rebus).
- **Position against competitors:** Warren covers only Spring and MassTransit; ServicePulse covers NServiceBus and MassTransit; the MassTransit v9 Dashboard covers MassTransit only and is commercial. An Apache-2.0 tool with 10+ decoders and correct replay across RabbitMQ 3.13 to 4.4 is clearly ahead.

## Open questions

- Lab test on 3.13, 4.0, 4.2, 4.3 and a 4.4 preview: after replaying a message with copied x-death and x-delivery-count headers, what do amqplib, the .NET and Java clients see at first delivery? Does the broker add a duplicate x-delivery-count key after a later return, and which value wins?
- Does a client-published x-delivery-count cause premature dead-lettering in consumers that use it, such as Rebus rbs2-delivery-count and NServiceBus immediate retries? Confirm that stripping it is enough.
- What header names and types does MassTransit v9 emit on _error? They are presumed identical to v8 from its docs and Particular's connector, but v9 source is not public; capture fixtures under a licence.
- How does MassTransit v9 queue-based redelivery behave? Check the x-death pattern on returns from mt-delay-{ms}, the restoration of MT-Original-RoutingKey, and how a replay should treat both.
- Do Wolverine 'attempts', Brighter HandledCount, Dramatiq options.retries, Laravel laravel.attempts and MassTransit MT-Redelivery-Count cause immediate dead-lettering when a message is replayed without a reset? Confirm per framework, and which reset each framework honours.
- EasyNetQ Error envelope fidelity: are original byte[] header values serialized as Base64 strings, and does a Hosepipe-style replay restore them correctly?
- NServiceBus shops usually run ServiceControl, which drains 'error'. Should the tool integrate read-only with the ServiceControl API (licensing and permission implications), or only detect it and step aside?
- Spring AMQP 4.0.5+ omits the stack trace by default. How common is RepublishMessageRecoverer compared with plain DLX in practice, and is message-template grouping good enough?
- Can Symfony PhpSerializer bodies (PHP serialize format with addslashes) be parsed safely and fully in TypeScript? How often do Laravel payloads use ShouldBeEncrypted, which makes them undecodable?
- On a 4.3 quorum queue with delayed-retry-type all or returned, does a nack-based peek delay message visibility for at least delayed-retry-min? How do the management API and Prometheus expose delayed counts?
- Peek side effects of the MassTransit v9 Dashboard and ServicePulse, which read through the management HTTP API (basic.get with requeue): measure their delivery-count impact on quorum-queue error queues.
- Which client_properties or connection names do Spring, kombu/Celery, Symfony (php-amqp), Laravel (php-amqplib), Wolverine, Rebus and EasyNetQ set? This decides whether frameworks can be identified from consumers even when the DLQ is empty.
- What is RabbitMQ-specific framework market share? Celery, NestJS and Symfony download counts include Redis and other transports, and Maven Central publishes no counts for Spring.
- Current MassTransit v9 list prices: massient.com renders them client-side, so only the 2025 price targets were verified.
- Is there any official statement extending v8 maintenance beyond 2026? None was found; the licence text calls v8 'unsupported under this Agreement'.

## Sources

- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.0.1.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.0.9/deps/rabbit/src/mc_amqpl.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.0/release-notes/4.3.0.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.3.0.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.0/deps/rabbit/src/rabbit_quorum_queue.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/v4.3.0/deps/rabbit/src/rabbit_fifo_client.erl
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-server/main/release-notes/4.4.0.md
- https://github.com/rabbitmq/rabbitmq-server/pull/16583
- https://api.github.com/repos/rabbitmq/rabbitmq-server/releases
- https://github.com/rabbitmq/rabbitmq-delayed-message-exchange
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-delayed-message-exchange/main/README.md
- https://api.github.com/repos/rabbitmq/rabbitmq-delayed-message-exchange
- https://api.github.com/repos/rabbitmq/rabbitmq-delayed-message-exchange/releases
- https://github.com/cloudamqp/rabbitmq-delayed-message-exchange
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/versioned_docs/version-4.3/quorum-queues/index.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/conversions.md
- https://raw.githubusercontent.com/rabbitmq/rabbitmq-website/main/docs/validated-user-id.md
- https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/MassTransit.Abstractions/MessageHeaders.cs
- https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/MassTransit.Abstractions/Contexts/SendContextExtensions.cs
- https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/MassTransit.Abstractions/Topology/Topology/DefaultErrorQueueNameFormatter.cs
- https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/MassTransit.Abstractions/Topology/Topology/DefaultDeadLetterQueueNameFormatter.cs
- https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/MassTransit/Middleware/ErrorTransportFilter.cs
- https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/MassTransit/Middleware/DeadLetterTransportFilter.cs
- https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/MassTransit/Middleware/Rescue/RescueExceptionReceiveContext.cs
- https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/Transports/MassTransit.RabbitMqTransport/RabbitMqTransport/RabbitMqErrorTransport.cs
- https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/Transports/MassTransit.RabbitMqTransport/RabbitMqTransport/RabbitMqMoveTransport.cs
- https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/Transports/MassTransit.RabbitMqTransport/RabbitMqTransport/RabbitMqDeadLetterTransport.cs
- https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/Transports/MassTransit.RabbitMqTransport/RabbitMqTransport/MoveTransportHeaders.cs
- https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/Transports/MassTransit.RabbitMqTransport/RabbitMqEndpointAddress.cs
- https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/Transports/MassTransit.RabbitMqTransport/RabbitMqTransport/RabbitMqSendTransportContext.cs
- https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/Transports/MassTransit.RabbitMqTransport/RabbitMqTransport/Configuration/ConfigurationHostSettings.cs
- https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/MassTransit/Serialization/SystemTextJsonMessageSerializer.cs
- https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/MassTransit/Serialization/SystemTextJsonRawMessageSerializer.cs
- https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/MassTransit.Newtonsoft/Serialization/NewtonsoftJsonMessageSerializer.cs
- https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/MassTransit.Newtonsoft/Serialization/BsonMessageSerializer.cs
- https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/MassTransit.Newtonsoft/Serialization/NewtonsoftXmlMessageSerializer.cs
- https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/MassTransit.Newtonsoft/Serialization/EncryptedMessageSerializer.cs
- https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/MassTransit.Newtonsoft/Serialization/EncryptedMessageSerializerV2.cs
- https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/MassTransit.MessagePack/Serialization/MessagePackMessageSerializer.cs
- https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/MassTransit.Abstractions/Serialization/Serialization/MessageEnvelope.cs
- https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/MassTransit.Abstractions/MessageUrn.cs
- https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/MassTransit.Abstractions/Util/ExceptionUtil.cs
- https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/MassTransit.Abstractions/TypeCache.cs
- https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.10/src/MassTransit/Contexts/ConsumeContextEndpointExtensions.cs
- https://raw.githubusercontent.com/MassTransit/MassTransit/develop/README.md
- https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.0/doc/content/1.introduction/v9-announcement.md
- https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.0/doc/content/3.documentation/1.concepts/4.exceptions.md
- https://raw.githubusercontent.com/MassTransit/MassTransit/v8.5.0/doc/content/3.documentation/3.patterns/11.transactional-outbox.md
- https://masstransit.io/introduction/v9-announcement
- https://massient.com/
- https://massient.com/license
- https://masstransit.massient.com/concepts/exceptions
- https://masstransit.massient.com/configuration/transports/rabbitmq
- https://masstransit.massient.com/configuration/middleware/redelivery
- https://masstransit.massient.com/configuration/dashboard/
- https://masstransit.massient.com/configuration/license/
- https://api.nuget.org/v3-flatcontainer/masstransit/index.json
- https://api.nuget.org/v3/catalog0/data/2026.01.06.20.13.15/masstransit.9.0.0.json
- https://api.nuget.org/v3/registration5-gz-semver2/masstransit/index.json
- https://api.nuget.org/v3/registration5-gz-semver2/masstransit.rabbitmq/index.json
- https://azuresearch-usnc.nuget.org/query?q=packageid:MassTransit.RabbitMQ
- https://milanjovanovic.tech/blog/mediatr-and-masstransit-going-commercial-what-this-means-for-you
- https://github.com/N0T-A-NUMB3R/MassLens
- https://docs.particular.net/nservicebus/messaging/headers
- https://raw.githubusercontent.com/Particular/docs.particular.net/master/nservicebus/messaging/headers.md
- https://raw.githubusercontent.com/Particular/docs.particular.net/master/nservicebus/recoverability/configure-error-handling.md
- https://raw.githubusercontent.com/Particular/docs.particular.net/master/nservicebus/outbox/index.md
- https://raw.githubusercontent.com/Particular/docs.particular.net/master/transports/rabbitmq/delayed-delivery.md
- https://raw.githubusercontent.com/Particular/docs.particular.net/master/transports/rabbitmq/connection-settings_delivery-limit-validation_rabbit_%5B10,%29.partial.md
- https://raw.githubusercontent.com/Particular/docs.particular.net/master/transports/rabbitmq/index_broker-compatibility_rabbit_%5B10,%29.partial.md
- https://raw.githubusercontent.com/Particular/docs.particular.net/master/transports/rabbitmq/native-integration.md
- https://raw.githubusercontent.com/Particular/NServiceBus.RabbitMQ/11.2.1/src/NServiceBus.Transport.RabbitMQ/Administration/BrokerVerifier.cs
- https://raw.githubusercontent.com/Particular/NServiceBus.RabbitMQ/11.2.1/src/NServiceBus.Transport.RabbitMQ/Administration/ManagementApi/Models/Queue.cs
- https://raw.githubusercontent.com/Particular/NServiceBus.RabbitMQ/11.2.1/src/NServiceBus.Transport.RabbitMQ/Sending/BasicPropertiesExtensions.cs
- https://raw.githubusercontent.com/Particular/NServiceBus.RabbitMQ/11.2.1/src/NServiceBus.Transport.RabbitMQ/DelayedDelivery/DelayInfrastructure.cs
- https://raw.githubusercontent.com/Particular/NServiceBus.RabbitMQ/11.2.1/src/NServiceBus.Transport.RabbitMQ/Connection/ConnectionFactory.cs
- https://raw.githubusercontent.com/Particular/ServiceControl/6.21.2/src/ServiceControl/Recoverability/Retrying/HeaderFilter.cs
- https://raw.githubusercontent.com/Particular/ServiceControl/6.21.2/src/ServiceControl.UnitTests/ApprovalFiles/HeaderFilterTests.RemovesHeaders.approved.txt
- https://raw.githubusercontent.com/Particular/ServiceControl/6.21.2/src/ServiceControl/Recoverability/Retrying/Infrastructure/ReturnToSender.cs
- https://raw.githubusercontent.com/Particular/ServiceControl/6.21.2/src/ServiceControl/Infrastructure/TransportMessageExtensions.cs
- https://raw.githubusercontent.com/Particular/ServiceControl/6.21.2/src/ServiceControl/Recoverability/Editing/EditHandler.cs
- https://raw.githubusercontent.com/Particular/ServiceControl/6.21.2/src/ServiceControl/Recoverability/Grouping/Groupers/ExceptionTypeAndStackTraceFailureClassifier.cs
- https://raw.githubusercontent.com/Particular/ServiceControl/6.21.2/LICENSE.md
- https://raw.githubusercontent.com/Particular/docs.particular.net/master/platform/masstransit.md
- https://raw.githubusercontent.com/Particular/docs.particular.net/master/servicecontrol/masstransit/index.md
- https://github.com/Particular/ServiceControl.Connector.MassTransit
- https://raw.githubusercontent.com/Particular/ServiceControl.Connector.MassTransit/HEAD/src/ServiceControl.Connector.MassTransit/MassTransitConverter.cs
- https://raw.githubusercontent.com/Particular/ServiceControl.Connector.MassTransit/HEAD/src/ServiceControl.Connector.MassTransit/MassTransitFailureAdapter.cs
- https://raw.githubusercontent.com/Particular/ServiceControl.Connector.MassTransit/HEAD/src/ServiceControl.Connector.MassTransit.RabbitMQ/RabbitMQMassTransitFailureAdapter.cs
- https://raw.githubusercontent.com/Particular/docs.particular.net/master/servicepulse/intro-editing-messages.md
- https://raw.githubusercontent.com/Particular/docs.particular.net/master/servicecontrol/servicecontrol-instances/configuration.md
- https://raw.githubusercontent.com/Particular/docs.particular.net/master/serviceinsight/serviceinsight-sunset.include.md
- https://raw.githubusercontent.com/JasperFx/wolverine/V6.51.0/src/Wolverine/Transports/DeadLetterQueueConstants.cs
- https://raw.githubusercontent.com/JasperFx/wolverine/V6.51.0/docs/guide/messaging/transports/rabbitmq/deadletterqueues.md
- https://raw.githubusercontent.com/JasperFx/wolverine/V6.51.0/docs/tutorials/dead-letter-queues.md
- https://raw.githubusercontent.com/JasperFx/wolverine/V6.51.0/src/Wolverine/EnvelopeConstants.cs
- https://raw.githubusercontent.com/JasperFx/wolverine/V6.51.0/src/Transports/RabbitMQ/Wolverine.RabbitMQ/Internal/RabbitMqEnvelopeMapper.cs
- https://raw.githubusercontent.com/JasperFx/wolverine/V6.51.0/src/Wolverine/DurabilitySettings.cs
- https://raw.githubusercontent.com/JasperFx/wolverine/V6.51.0/docs/guide/durability/dead-letter-storage.md
- https://raw.githubusercontent.com/JasperFx/wolverine/V6.51.0/docs/guide/messaging/transports/rabbitmq/index.md
- https://raw.githubusercontent.com/rebus-org/Rebus/8.9.5/Rebus/Messages/Headers.cs
- https://raw.githubusercontent.com/rebus-org/Rebus/8.9.5/Rebus/Retry/PoisonQueues/DeadletterQueueErrorHandler.cs
- https://raw.githubusercontent.com/rebus-org/Rebus/8.9.5/Rebus/Retry/Simple/RetryStrategySettings.cs
- https://raw.githubusercontent.com/rebus-org/Rebus/8.9.5/Rebus/Retry/Simple/DefaultRetryStep.cs
- https://raw.githubusercontent.com/rebus-org/Rebus/8.9.5/Rebus/Retry/ExceptionInfo.cs
- https://raw.githubusercontent.com/rebus-org/Rebus/8.9.5/Rebus/Retry/ErrorTracking/InMemErrorTracker.cs
- https://raw.githubusercontent.com/rebus-org/Rebus/8.9.5/Rebus/Serialization/Json/SystemTextJsonSerializer.cs
- https://raw.githubusercontent.com/rebus-org/Rebus.RabbitMq/10.1.2/Rebus.RabbitMq/Internals/RabbitMqErrorHandlerDecorator.cs
- https://raw.githubusercontent.com/rebus-org/Rebus.RabbitMq/10.1.2/Rebus.RabbitMq/RabbitMq/RabbitMqTransport.cs
- https://raw.githubusercontent.com/rebus-org/Rebus.RabbitMq/10.1.2/Rebus.RabbitMq/RabbitMq/RabbitMqHeaders.cs
- https://raw.githubusercontent.com/rebus-org/Rebus.RabbitMq/10.1.2/Rebus.RabbitMq/Config/RabbitMqOptionsBuilder.cs
- https://rebus.fm/fleet-manager/
- https://github.com/rebus-org/FleetManager
- https://raw.githubusercontent.com/BrighterCommand/Brighter/10.8.0/src/Paramore.Brighter.MessagingGateway.RMQ.Async/HeaderNames.cs
- https://raw.githubusercontent.com/BrighterCommand/Brighter/10.8.0/src/Paramore.Brighter.MessagingGateway.RMQ.Async/RmqMessageConsumer.cs
- https://raw.githubusercontent.com/BrighterCommand/Brighter/10.8.0/src/Paramore.Brighter.MessagingGateway.RMQ.Async/RmqMessagePublisher.cs
- https://raw.githubusercontent.com/BrighterCommand/Brighter/10.8.0/src/Paramore.Brighter/Message.cs
- https://raw.githubusercontent.com/EasyNetQ/EasyNetQ/8.1.11/Source/EasyNetQ/SystemMessages/Error.cs
- https://raw.githubusercontent.com/EasyNetQ/EasyNetQ/8.1.11/Source/EasyNetQ/Consumer/DefaultConsumeErrorStrategy.cs
- https://raw.githubusercontent.com/EasyNetQ/EasyNetQ/8.1.11/Source/EasyNetQ/Conventions.cs
- https://raw.githubusercontent.com/EasyNetQ/EasyNetQ/8.1.11/Source/EasyNetQ/Consumer/DefaultErrorMessageSerializer.cs
- https://raw.githubusercontent.com/EasyNetQ/EasyNetQ/8.1.11/Source/EasyNetQ.Hosepipe/ErrorRetry.cs
- https://raw.githubusercontent.com/EasyNetQ/EasyNetQ/8.1.11/Source/EasyNetQ/MessageProperties.cs
- https://raw.githubusercontent.com/EasyNetQ/EasyNetQ/8.1.11/Source/EasyNetQ/DeadLetterExchangeAndMessageTtlScheduler.cs
- https://raw.githubusercontent.com/EasyNetQ/EasyNetQ/8.1.11/Source/EasyNetQ/ServiceCollectionExtensions.cs
- https://github.com/EasyNetQ/EasyNetQ/wiki/Re-Submitting-Error-Messages-With-EasyNetQ.Hosepipe
- https://github.com/EasyNetQ/EasyNetQ/wiki/EasyNetQ-v8-Migration-Guide
- https://raw.githubusercontent.com/dotnetcore/CAP/master/src/DotNetCore.CAP/Messages/Headers.cs
- https://raw.githubusercontent.com/spring-projects/spring-amqp/v4.1.1/spring-rabbit/src/main/java/org/springframework/amqp/rabbit/retry/RepublishMessageRecoverer.java
- https://raw.githubusercontent.com/spring-projects/spring-amqp/v4.0.4/spring-rabbit/src/main/java/org/springframework/amqp/rabbit/retry/RepublishMessageRecoverer.java
- https://raw.githubusercontent.com/spring-projects/spring-amqp/v4.0.5/spring-rabbit/src/main/java/org/springframework/amqp/rabbit/retry/RepublishMessageRecoverer.java
- https://github.com/spring-projects/spring-amqp/issues/3518
- https://raw.githubusercontent.com/spring-projects/spring-amqp/v4.1.1/spring-amqp/src/main/java/org/springframework/amqp/core/MessageProperties.java
- https://raw.githubusercontent.com/spring-projects/spring-amqp/v4.1.1/spring-rabbit/src/main/java/org/springframework/amqp/rabbit/support/DefaultMessagePropertiesConverter.java
- https://raw.githubusercontent.com/spring-projects/spring-amqp/v4.1.1/src/reference/antora/modules/ROOT/pages/appendix/previous-whats-new/changes-in-3-2-since-3-1.adoc
- https://raw.githubusercontent.com/spring-projects/spring-amqp/v4.1.1/src/reference/antora/modules/ROOT/pages/amqp/resilience-recovering-from-errors-and-broker-failures.adoc
- https://raw.githubusercontent.com/spring-projects/spring-amqp/v4.1.1/spring-amqp/src/main/java/org/springframework/amqp/support/converter/AbstractJavaTypeMapper.java
- https://raw.githubusercontent.com/spring-projects/spring-amqp/v4.1.1/spring-amqp/src/main/java/org/springframework/amqp/support/postprocessor/AbstractCompressingPostProcessor.java
- https://raw.githubusercontent.com/spring-cloud/spring-cloud-stream/v5.0.3/binders/rabbit-binder/spring-cloud-stream-binder-rabbit/src/main/java/org/springframework/cloud/stream/binder/rabbit/RabbitMessageChannelBinder.java
- https://raw.githubusercontent.com/spring-cloud/spring-cloud-stream/v5.1.0-M1/binders/rabbit-binder/spring-cloud-stream-binder-rabbit/src/main/java/org/springframework/cloud/stream/binder/rabbit/RabbitMessageChannelBinder.java
- https://raw.githubusercontent.com/spring-cloud/spring-cloud-stream/v5.0.3/binders/rabbit-binder/spring-cloud-stream-binder-rabbit-core/src/main/java/org/springframework/cloud/stream/binder/rabbit/properties/RabbitConsumerProperties.java
- https://raw.githubusercontent.com/spring-cloud/spring-cloud-stream/v5.0.3/binders/rabbit-binder/spring-cloud-stream-binder-rabbit-core/src/main/java/org/springframework/cloud/stream/binder/rabbit/properties/RabbitCommonProperties.java
- https://raw.githubusercontent.com/spring-cloud/spring-cloud-stream/v5.0.3/binders/rabbit-binder/spring-cloud-stream-binder-rabbit-core/src/main/java/org/springframework/cloud/stream/binder/rabbit/provisioning/RabbitExchangeQueueProvisioner.java
- https://raw.githubusercontent.com/spring-cloud/spring-cloud-stream/v5.0.3/docs/modules/ROOT/pages/rabbit/rabbit_dlq.adoc
- https://raw.githubusercontent.com/celery/celery/v5.6.3/docs/internals/protocol.rst
- https://raw.githubusercontent.com/celery/celery/v5.6.3/celery/app/amqp.py
- https://raw.githubusercontent.com/celery/celery/v5.6.3/celery/worker/request.py
- https://raw.githubusercontent.com/celery/celery/v5.6.3/docs/getting-started/backends-and-brokers/rabbitmq.rst
- https://raw.githubusercontent.com/celery/kombu/v5.6.2/kombu/transport/native_delayed_delivery.py
- https://raw.githubusercontent.com/celery/kombu/v5.5.0/kombu/transport/native_delayed_delivery.py
- https://raw.githubusercontent.com/mher/flower/master/flower/api/tasks.py
- https://raw.githubusercontent.com/Bogdanp/dramatiq/v2.2.1/dramatiq/brokers/rabbitmq.py
- https://raw.githubusercontent.com/Bogdanp/dramatiq/v2.2.1/dramatiq/common.py
- https://raw.githubusercontent.com/Bogdanp/dramatiq/v2.2.1/dramatiq/middleware/retries.py
- https://raw.githubusercontent.com/Bogdanp/dramatiq/v2.2.1/dramatiq/message.py
- https://raw.githubusercontent.com/Bogdanp/dramatiq/v2.2.1/dramatiq/worker.py
- https://raw.githubusercontent.com/Bogdanp/dramatiq_dashboard/master/README.md
- https://raw.githubusercontent.com/ag2ai/faststream/0.7.7/faststream/middlewares/acknowledgement/config.py
- https://raw.githubusercontent.com/ag2ai/faststream/0.7.7/faststream/rabbit/subscriber/config.py
- https://raw.githubusercontent.com/ag2ai/faststream/0.7.7/faststream/rabbit/parser.py
- https://raw.githubusercontent.com/symfony/symfony/v8.1.9/src/Symfony/Component/Messenger/Bridge/Amqp/Transport/Connection.php
- https://raw.githubusercontent.com/symfony/symfony/v8.1.9/src/Symfony/Component/Messenger/Bridge/Amqp/Transport/AmqpSender.php
- https://raw.githubusercontent.com/symfony/symfony/v8.1.9/src/Symfony/Component/Messenger/Transport/Serialization/PhpSerializer.php
- https://raw.githubusercontent.com/symfony/symfony/v8.1.9/src/Symfony/Component/Messenger/Transport/Serialization/Serializer.php
- https://raw.githubusercontent.com/symfony/symfony/v8.1.9/src/Symfony/Component/Messenger/Stamp/ErrorDetailsStamp.php
- https://raw.githubusercontent.com/symfony/symfony/v8.1.9/src/Symfony/Component/Messenger/Stamp/RedeliveryStamp.php
- https://raw.githubusercontent.com/symfony/symfony/v8.1.9/src/Symfony/Component/Messenger/Stamp/SentToFailureTransportStamp.php
- https://raw.githubusercontent.com/symfony/symfony/v8.1.9/src/Symfony/Component/Messenger/Command/FailedMessagesRetryCommand.php
- https://raw.githubusercontent.com/vyuldashev/laravel-queue-rabbitmq/v15.0.2/src/Queue/RabbitMQQueue.php
- https://raw.githubusercontent.com/vyuldashev/laravel-queue-rabbitmq/v15.0.2/src/Queue/QueueConfig.php
- https://raw.githubusercontent.com/vyuldashev/laravel-queue-rabbitmq/v15.0.2/src/Queue/Jobs/RabbitMQJob.php
- https://raw.githubusercontent.com/vyuldashev/laravel-queue-rabbitmq/v15.0.2/README.md
- https://raw.githubusercontent.com/laravel/framework/v13.37.0/src/Illuminate/Queue/Queue.php
- https://raw.githubusercontent.com/laravel/framework/v13.37.0/src/Illuminate/Queue/Console/RetryCommand.php
- https://raw.githubusercontent.com/laravel/horizon/5.x/README.md
- https://github.com/php-amqplib/php-amqplib/blob/master/demo/delayed_message.php
- https://raw.githubusercontent.com/nestjs/nest/v12.1.3/packages/microservices/server/server-rmq.ts
- https://raw.githubusercontent.com/nestjs/nest/v12.1.3/packages/microservices/constants.ts
- https://raw.githubusercontent.com/nestjs/nest/v12.1.3/packages/microservices/client/client-rmq.ts
- https://raw.githubusercontent.com/golevelup/nestjs/master/packages/rabbitmq/src/amqp/errorBehaviors.ts
- https://raw.githubusercontent.com/golevelup/nestjs/master/packages/rabbitmq/src/amqp/connection.ts
- https://raw.githubusercontent.com/moleculerjs/moleculer-channels/v0.3.1/src/constants.js
- https://raw.githubusercontent.com/moleculerjs/moleculer-channels/v0.3.1/src/adapters/amqp.js
- https://raw.githubusercontent.com/moleculerjs/moleculer-channels/v0.3.1/src/utils.js
- https://raw.githubusercontent.com/moleculerjs/moleculer-channels/v0.3.1/src/adapters/base.js
- https://raw.githubusercontent.com/ThreeDotsLabs/watermill/v1.5.3/message/router/middleware/poison.go
- https://raw.githubusercontent.com/ThreeDotsLabs/watermill/v1.5.3/message/router/middleware/retry.go
- https://raw.githubusercontent.com/ThreeDotsLabs/watermill/v1.5.3/components/requeuer/requeuer.go
- https://raw.githubusercontent.com/ThreeDotsLabs/watermill/v1.5.3/components/delay/delay.go
- https://raw.githubusercontent.com/ThreeDotsLabs/watermill-amqp/v3.1.0/pkg/amqp/marshaler.go
- https://raw.githubusercontent.com/ruby-amqp/kicks/3.4.0/lib/sneakers/handlers/maxretry.rb
- https://raw.githubusercontent.com/jondot/sneakers/v2.12.0/lib/sneakers/handlers/maxretry.rb
- https://raw.githubusercontent.com/jondot/sneakers/v2.11.0/lib/sneakers/handlers/maxretry.rb
- https://raw.githubusercontent.com/jondot/sneakers/v2.7.0/lib/sneakers/handlers/maxretry.rb
- https://raw.githubusercontent.com/ruby-amqp/hutch/v2.0.0/lib/hutch/acknowledgements/nack_on_all_failures.rb
- https://raw.githubusercontent.com/ruby-amqp/hutch/v2.0.0/lib/hutch/broker.rb
- https://raw.githubusercontent.com/ruby-amqp/bunny/main/lib/bunny/queue.rb
- https://raw.githubusercontent.com/FoundatioFx/Foundatio.RabbitMQ/main/src/Foundatio.RabbitMQ/Messaging/DelayedRetryType.cs
- https://warrenops.io
- https://www.cogin.com/mq/
- https://pypistats.org/api/packages/celery/recent
- https://pypistats.org/api/packages/kombu/recent
- https://pypistats.org/api/packages/flower/recent
- https://pypistats.org/api/packages/dramatiq/recent
- https://pypistats.org/api/packages/faststream/recent
- https://pypistats.org/api/packages/pika/recent
- https://pypistats.org/api/packages/aio-pika/recent
- https://api.npmjs.org/downloads/point/last-month/@nestjs/microservices
- https://api.npmjs.org/downloads/point/last-month/amqp-connection-manager
- https://api.npmjs.org/downloads/point/last-month/@golevelup/nestjs-rabbitmq
- https://api.npmjs.org/downloads/point/last-month/amqplib
- https://api.npmjs.org/downloads/point/last-month/moleculer
- https://api.npmjs.org/downloads/point/last-month/@moleculer/channels
- https://packagist.org/packages/symfony/amqp-messenger.json
- https://packagist.org/packages/symfony/messenger.json
- https://packagist.org/packages/vladimir-yuldashev/laravel-queue-rabbitmq.json
- https://packagist.org/packages/php-amqplib/php-amqplib.json
- https://packagist.org/packages/enqueue/amqp-lib.json
- https://rubygems.org/api/v1/gems/sneakers.json
- https://rubygems.org/api/v1/gems/kicks.json
- https://rubygems.org/api/v1/gems/hutch.json
- https://rubygems.org/api/v1/gems/bunny.json
- https://rubygems.org/api/v1/versions/sneakers.json
- https://azuresearch-usnc.nuget.org/query?q=packageid:NServiceBus.RabbitMQ
- https://azuresearch-usnc.nuget.org/query?q=packageid:WolverineFx.RabbitMQ
- https://azuresearch-usnc.nuget.org/query?q=packageid:Rebus.RabbitMq
- https://azuresearch-usnc.nuget.org/query?q=packageid:Paramore.Brighter.MessagingGateway.RMQ.Async
- https://azuresearch-usnc.nuget.org/query?q=packageid:EasyNetQ
- https://azuresearch-usnc.nuget.org/query?q=packageid:RabbitMQ.Client
- https://azuresearch-usnc.nuget.org/query?q=packageid:DotNetCore.CAP.RabbitMQ
- https://api.github.com/repos/MassTransit/MassTransit
- https://api.github.com/repos/Particular/NServiceBus
- https://api.github.com/repos/JasperFx/wolverine
- https://api.github.com/repos/rebus-org/Rebus
- https://api.github.com/repos/BrighterCommand/Brighter
- https://api.github.com/repos/EasyNetQ/EasyNetQ
- https://api.github.com/repos/spring-projects/spring-amqp
- https://api.github.com/repos/spring-cloud/spring-cloud-stream
- https://api.github.com/repos/celery/celery
- https://api.github.com/repos/mher/flower
- https://api.github.com/repos/Bogdanp/dramatiq
- https://api.github.com/repos/ag2ai/faststream
- https://api.github.com/repos/vyuldashev/laravel-queue-rabbitmq
- https://api.github.com/repos/golevelup/nestjs
- https://api.github.com/repos/moleculerjs/moleculer-channels
- https://api.github.com/repos/ThreeDotsLabs/watermill
- https://api.github.com/repos/ruby-amqp/kicks
- https://api.github.com/repos/ruby-amqp/hutch
- https://api.github.com/repos/dotnetcore/CAP
