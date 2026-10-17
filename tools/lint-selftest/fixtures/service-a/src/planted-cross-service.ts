// PLANTED VIOLATION: a service must never import another service.
import { fixture } from '@lint-fixtures/service-b';

export const planted = fixture;
