// Lab cell CF-SETTLE-01. The evidence file testing/lab-evidence/<broker-version>/CF-SETTLE-01.json is
// recorded by `conformance:record` and committed by a human; do not create it here.
//
// The three-way assertion (M0-37): the live run, the recorded evidence and the registry cell must
// agree. Until CI has recorded evidence for a version, the result is `unverified`, never a pass.
import { describeThreeWay } from '../assert/cell-spec.ts';

describeThreeWay('CF-SETTLE-01');
