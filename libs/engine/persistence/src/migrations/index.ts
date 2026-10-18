import type { Migration } from '../migrate/types';
import { migration0001Core } from './0001_core';
import { migration0002Plans } from './0002_plans';

export const migrations: readonly Migration[] = [
  migration0001Core,
  migration0002Plans,
];
