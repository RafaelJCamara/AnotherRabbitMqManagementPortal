// The switcher's real answer for entity addresses (M1-42, R4): does the object exist on the other connection? The
// explorer is a lazy library, so it is loaded when the question is first asked, and it answers from the other
// connection's inventory: `false` only when that inventory is live and complete and does not hold the object.
// Anything that is not an entity address keeps the switcher's default answer (no).
import { Injector, inject, type Provider } from '@angular/core';

import { ADDRESS_EXISTS, type AddressExists } from './switch-target';

export function provideAddressExists(): Provider {
  return {
    provide: ADDRESS_EXISTS,
    useFactory: (): AddressExists => {
      const injector = inject(Injector);
      return async (cid, address) => {
        const feature = await import('@app/feature-explorer');
        return feature.addressExists(
          injector.get(feature.EXPLORER_DATA),
          cid,
          address,
        );
      };
    },
  };
}
