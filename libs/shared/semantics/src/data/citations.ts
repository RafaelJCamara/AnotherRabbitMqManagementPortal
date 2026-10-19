// The sources the M0-12 cells cite, written once. Every `ref` of kind S is `RS@<tag>:<path>` (the
// broker source at an exact tag) followed by the function or lines the fact sheet names
// (docs/research/fact-sheet.md, sections 0.11, 0.15, b.2, b.4 and b.5). Nothing here was lab-tested.
import type { Citation } from '../schema.ts';

const source = (ref: string): Citation => ({ kind: 'S', ref });

// 3.13
export const FIFO_313_RETURN = source(
  'RS@v3.13.7:deps/rabbit/src/rabbit_fifo.erl return_one L1847-1863 (discards when DeliveryCount > DeliveryLimit)',
);
export const FIFO_313_LIMIT = source(
  'RS@v3.13.7:deps/rabbit/src/rabbit_fifo.erl L159 (the delivery limit is kept as configured, negatives included)',
);
export const QQ_313_MERGE = source(
  'RS@v3.13.7:deps/rabbit/src/rabbit_quorum_queue.erl L315 (argument and policy merged with min/2)',
);
export const PLUGIN_313 = source(
  'RS@v3.13.7:deps/rabbitmq_amqp1_0/src/rabbit_amqp1_0_session_process.erl L296-326 (AMQP 1.0 outcomes mapped onto AMQP 0-9-1 methods)',
);

// 4.0 to 4.2
export const FIFO_42_LIMIT = source(
  'RS@v4.2.9:deps/rabbit/src/rabbit_fifo.erl L1954-1957 (AcquiredCount > DeliveryLimit)',
);
export const FIFO_42_INCR = source(
  'RS@v4.2.9:deps/rabbit/src/rabbit_fifo.erl incr_msg/3 L3097-3111',
);
export const CHANNEL_42 = source(
  'RS@v4.2.9:deps/rabbit/src/rabbit_channel.erl internal_reject L1976-1985 (basic.nack and basic.reject are one operation)',
);
export const CLIENT_42 = source(
  'RS@v4.2.9:deps/rabbit/src/rabbit_fifo_client.erl L241-258 (x-delivery-count shows the acquired count)',
);
export const SUITE_42 = source(
  'RS@v4.2.9:deps/rabbit/test/quorum_queue_SUITE.erl subscribe_redelivery_policy (a nack-based drop test)',
);

// 4.3
export const FIFO_43_RETURN = source(
  'RS@v4.3.6:deps/rabbit/src/rabbit_fifo.erl return_one L2348-2398 (DeliveryCount > DeliveryLimit on every return)',
);
export const FIFO_43_HEADERS = source(
  'RS@v4.3.6:deps/rabbit/src/rabbit_fifo.erl incr_msg_headers L3884-3899',
);
export const FIFO_43_RETURN_ALL = source(
  'RS@v4.3.6:deps/rabbit/src/rabbit_fifo.erl maybe_return_all L1954-1972',
);
export const FIFO_43_TIMEOUT = source(
  'RS@v4.3.6:deps/rabbit/src/rabbit_fifo.erl consumer timeout L721-794 (return_multiple with delivery-failed false)',
);
export const FIFO_43_CARRY = source(
  'RS@v4.3.6:deps/rabbit/src/rabbit_fifo.erl maybe_set_msg_delivery_count L2032-2044 (a quorum queue seeds its delivery count from the annotations)',
);
export const CHANNEL_430 = source(
  'RS@v4.3.0:deps/rabbit/src/rabbit_channel.erl L1478-1486 (basic.nack and basic.reject first split)',
);
export const AMQP_SESSION_43 = source(
  'RS@v4.3.6:deps/rabbit/src/rabbit_amqp_session.erl L2129-2160 (AMQP 1.0 outcomes)',
);
export const MC_AMQP = source(
  'RS@v4.3.6:deps/rabbit/src/mc_amqp.erl essential_properties (a publisher cannot inject a delivery count)',
);

export const DOCS_QQ: Citation = {
  kind: 'D',
  ref: 'WEB:docs/quorum-queues/index.md and versioned_docs/version-4.2',
};

export const M3_DEVTO: Citation = {
  kind: 'M3',
  ref: 'https://dev.to/viktorbaumann/your-quorum-dead-letter-queue-can-drop-the-dead-letters-x-delivery-count-travels-along-240n (4.3.6: 21 abandoned deliveries gave x-delivery-count 21 in the DLQ)',
};
