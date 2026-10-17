import { typescriptTester } from '../test-utils.ts';
import { explicitZodSchemas } from './explicit-zod-schemas.ts';

typescriptTester().run('explicit-zod-schemas', explicitZodSchemas, {
  valid: [
    "import { z } from 'zod'; const A = z.object({ id: z.string(), size: z.number() });",
    "import { z } from 'zod'; const A = z.strictObject({ id: z.string() });",
    "import { z } from 'zod'; const A = z.object({ a: z.string() }).catchall(z.never());",
    "import { z } from 'zod'; const A = z.unknown();",
    // `z` that is not zod.
    "import { z } from './local'; const A = z.any();",
    'const a = z.any();',
    // `.loose()` on something that is not a schema, in a file with no zod import.
    'config.loose();',
  ],
  invalid: [
    {
      code: "import { z } from 'zod'; const A = z.any();",
      errors: [{ messageId: 'factory', data: { name: 'z.any' } }],
    },
    {
      code: "import * as z from 'zod'; const A = z.looseObject({ id: z.string() });",
      errors: [{ messageId: 'factory' }],
    },
    {
      code: "import { z } from 'zod/v4'; const A = z.record(z.string(), z.any());",
      errors: [{ messageId: 'factory' }],
    },
    {
      code: "import { z } from '@app/contracts'; const A = z.any();",
      errors: [{ messageId: 'factory' }],
    },
    {
      code: "import { any } from 'zod'; const A = any();",
      errors: [{ messageId: 'factory', data: { name: 'z.any' } }],
    },
    {
      code: "import { z } from 'zod'; const A = z.object({ id: z.string() }).passthrough();",
      errors: [{ messageId: 'method', data: { name: 'passthrough' } }],
    },
    {
      code: "import { z } from 'zod'; const A = z.object({ id: z.string() }).loose();",
      errors: [{ messageId: 'method', data: { name: 'loose' } }],
    },
    {
      code: "import { z } from 'zod'; const A = z.object({}).catchall(z.string());",
      errors: [{ messageId: 'method', data: { name: 'catchall' } }],
    },
    {
      // No import needed for the zod 3 spelling that is always wrong.
      code: 'const A = schema.passthrough();',
      errors: [{ messageId: 'method' }],
    },
  ],
});
