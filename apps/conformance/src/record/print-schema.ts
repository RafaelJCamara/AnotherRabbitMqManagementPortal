// Prints the JSON Schema of an evidence artefact. `testing/lab-evidence/schema.json` is a protected
// path (agents never write it), so a maintainer commits it:
//
//   node apps/conformance/src/record/print-schema.ts > testing/lab-evidence/schema.json
//
// The schema is generated from the zod schema in evidence.ts, which is what the recorder and the
// verifier use, so the file cannot drift from the code that checks artefacts.
import { evidenceJsonSchema } from './evidence.ts';

process.stdout.write(`${JSON.stringify(evidenceJsonSchema(), null, 2)}\n`);
