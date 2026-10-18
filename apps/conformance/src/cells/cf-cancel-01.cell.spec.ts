// Lab cell CF-CANCEL-01. The evidence file testing/lab-evidence/<broker-version>/CF-CANCEL-01.json is
// recorded by `conformance:record` and committed by a human; do not create it here.
//
// The question: after a server-initiated basic.cancel, can a delivery that was held at that
// moment still be nacked (requeue) or acked on the same channel (U-17, OQ-219)? The live run is
// libs/engine/adapter-amqp091/contract/server-cancel.contract.spec.ts (M0-28), which writes what
// it saw for amqplib and @cloudamqp/amqp-client to dist/contract-evidence/<broker>/server-cancel.json
// on every lab broker. M1-06 adds the 4.3 consumer-timeout trigger. No registry cell exists yet:
// the settle actions of @app/semantics have no basic.cancel entry (OQ-261).
import { describe, it } from 'vitest';

describe('CF-CANCEL-01', () => {
  it.todo('the live run matches the recorded evidence');
  it.todo('the registry cell matches the recorded evidence');
});
