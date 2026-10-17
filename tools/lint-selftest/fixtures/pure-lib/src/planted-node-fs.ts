// PLANTED VIOLATION: a type:pure library must not use Node builtins.
import { readFileSync } from 'node:fs';

export const planted = readFileSync;
