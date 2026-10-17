// PLANTED VIOLATION: a type:contracts library may only depend on zod. `rxjs` stands for any other
// package; the positive case (zod itself) is allowed-zod.ts.
import { Observable } from 'rxjs';

export const planted = Observable;
