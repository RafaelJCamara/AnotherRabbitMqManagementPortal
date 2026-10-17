// A type:contracts library may depend on zod, and on nothing else.
import { z } from 'zod';

export const Fixture = z.strictObject({ id: z.string() });
