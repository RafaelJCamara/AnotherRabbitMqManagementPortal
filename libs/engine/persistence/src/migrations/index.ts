import type { Migration } from '../migrate/types';
import { migration0001Core } from './0001_core';
import { migration0002Plans } from './0002_plans';
import { migration0003AuditReceipts } from './0003_audit_receipts';
import { migration0004DataKeys } from './0004_data_keys';
import { migration0005Jobs } from './0005_jobs';
import { migration0006Workspace } from './0006_workspace';
import { migration0007Credentials } from './0007_credentials';
import { migration0008BrokerProfiles } from './0008_broker_profiles';

export const migrations: readonly Migration[] = [
  migration0001Core,
  migration0002Plans,
  migration0003AuditReceipts,
  migration0004DataKeys,
  migration0005Jobs,
  migration0006Workspace,
  migration0007Credentials,
  migration0008BrokerProfiles,
];
