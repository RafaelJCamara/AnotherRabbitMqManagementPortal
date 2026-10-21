// Must stay the first import: it configures zod for Trusted Types before any schema in the app is
// built (zod would otherwise probe `new Function('')`, which the browser refuses and reports; #277).
import '@app/contracts';

import { bootApp } from './app/boot/boot';

bootApp().catch((err: unknown) => {
  console.error(err);
});
