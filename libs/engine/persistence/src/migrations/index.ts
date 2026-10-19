import type { Migration } from '../migrate/types';
import { migration0001Core } from './0001_core';
import { migration0002Plans } from './0002_plans';
import { migration0003AuditReceipts } from './0003_audit_receipts';
import { migration0004DataKeys } from './0004_data_keys';
import { migration0005Jobs } from './0005_jobs';

export const migrations: readonly Migration[] = [
  migration0001Core,
  migration0002Plans,
  migration0003AuditReceipts,
  migration0004DataKeys,
  migration0005Jobs,
];
