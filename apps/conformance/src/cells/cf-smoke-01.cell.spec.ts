// Lab cell CF-SMOKE-01. The evidence file testing/lab-evidence/<broker-version>/CF-SMOKE-01.json is
// recorded by `conformance:record` and committed by a human; do not create it here.
//
// The three-way assertion (M0-37): the live run, the recorded evidence and the registry cell must
// agree. No registry cell names CF-SMOKE-01, so the best this lab cell can be is `unverified` until
// evidence is recorded; a recorded artefact that the live run contradicts fails it.
import { describeThreeWay } from '../assert/cell-spec.ts';

describeThreeWay('CF-SMOKE-01');
