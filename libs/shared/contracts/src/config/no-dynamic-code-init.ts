// Side effect, on purpose: this module is the first import of the package index so that it runs
// before any schema of the registry is built (see no-dynamic-code.ts).
import { forbidDynamicCodeUnderTrustedTypes } from './no-dynamic-code.ts';

forbidDynamicCodeUnderTrustedTypes();
